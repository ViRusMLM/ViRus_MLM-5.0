// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract VirusMLM is ReentrancyGuard, AccessControl {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ========== КОНСТАНТЫ ==========
    uint256 public constant MIN_WITHDRAW = 10 ether;
    uint256 public constant POOL_DISTRIBUTION_INTERVAL = 1 days;
    uint256 public constant VIP_DURATION = 30 days;
    uint256 public constant MAX_REFERRAL_DEPTH = 12;
    uint256 public constant MAX_VIP_CLEANUP = 200;
    uint256 public constant BFS_QUEUE_SIZE = 8192;
    uint256 public constant BATCH_LIMIT = 200;

    uint256[] public PACKETS = [0, 50 ether, 100 ether, 150 ether, 200 ether, 250 ether];

    mapping(uint256 => uint256) public WITHDRAW_PERCENTAGES;
    uint256[5] public POOL_SHARES = [21, 33, 15, 12, 9];

    // ========== АДРЕСА ==========
    IERC20 public immutable usdtToken;
    address public reinvestFeeWallet;
    address public gamePoolWallet;
    address public reserveWallet;
    address public rootId;
    address public developmentFundWallet;

    // ========== СТРУКТУРЫ ==========
    struct User {
        uint256 currentPacket;
        address referrer;
        uint256 placementId;
        uint256 matrixBalance;
        uint256 poolBalance;
        uint256 totalEarned;
        uint256 registrationTime;
    }

    struct MatrixNode {
        uint256 id;
        address user;
        uint256 parent;
        uint256 leftChild;
        uint256 rightChild;
        uint256 depth;
        uint256 leftCount;
        uint256 rightCount;
        uint256 position;
        bool exists;
    }

    struct VipInfo {
        uint256 starLevel;
        uint256 verifiedAt;
        uint256 expiresAt;
        bool antiSybilVerified;
        bool isActive;
    }

    // ========== ХРАНИЛИЩЕ ==========
    mapping(address => User) public users;
    mapping(uint256 => MatrixNode) public matrixNodes;
    mapping(address => bool) public isRegistered;
    mapping(address => VipInfo) public vipInfo;
    mapping(uint256 => address[]) private vipByLevel;
    mapping(address => uint256) private vipIndexInLevel;

    EnumerableSet.AddressSet private matrixClaimQueue;
    EnumerableSet.AddressSet private poolClaimQueue;

    uint256 public totalUsers;
    uint256 public liquidityPool;
    uint256 public lastPoolDistribution;
    uint256 public totalMatrixPayouts;
    uint256 public totalPoolPayouts;
    uint256 public totalReferralPayouts;

    // ========== СОБЫТИЯ ==========
    event UserRegistered(address indexed user, address indexed referrer);
    event PacketActivated(address indexed user, uint256 packet);
    event ReferralPayout(address indexed sponsor, address indexed user, uint256 amount, bool toPool);
    event MatrixPayout(address indexed user, uint256 amount);
    event MatrixClaimed(address indexed user, uint256 toWallet, uint256 reinvested);
    event PoolDistributed(uint256 totalAmount, uint256[5] distributedPerLevel, uint256 reserved);
    event PoolClaimed(address indexed user, uint256 toWallet, uint256 reinvested);
    event VipRequested(address indexed user, uint256 starLevel);
    event VipConfirmed(address indexed user, uint256 starLevel, uint256 expiresAt);
    event VipRenewed(address indexed user, uint256 starLevel, uint256 expiresAt);
    event VipRevoked(address indexed user);
    event AntiSybilVerified(address indexed user);
    event PoolDonated(address indexed donor, uint256 amount);
    event BatchVipConfirmed(address[] users, uint256 starLevel, uint256 count);
    event BatchClaimed(address[] users, uint256 matrixCount, uint256 poolCount, uint256 totalUsers);
    event ClaimAll(address indexed user, uint256 matrixToWallet, uint256 poolToWallet);

    // ========== КОНСТРУКТОР ==========
    constructor(
        address _usdtToken,
        address _reinvestFeeWallet,
        address _gamePoolWallet,
        address _reserveWallet,
        address _rootId,
        address _developmentFundWallet
    ) {
        require(_usdtToken != address(0), "Invalid USDT");
        require(_reinvestFeeWallet != address(0), "Invalid reinvest wallet");
        require(_gamePoolWallet != address(0), "Invalid game wallet");
        require(_reserveWallet != address(0), "Invalid reserve wallet");
        require(_rootId != address(0), "Invalid rootId");
        require(_developmentFundWallet != address(0), "Invalid dev fund");

        usdtToken = IERC20(_usdtToken);
        reinvestFeeWallet = _reinvestFeeWallet;
        gamePoolWallet = _gamePoolWallet;
        reserveWallet = _reserveWallet;
        rootId = _rootId;
        developmentFundWallet = _developmentFundWallet;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MULTISIG_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);

        WITHDRAW_PERCENTAGES[50 ether] = 50;
        WITHDRAW_PERCENTAGES[100 ether] = 60;
        WITHDRAW_PERCENTAGES[150 ether] = 70;
        WITHDRAW_PERCENTAGES[200 ether] = 80;
        WITHDRAW_PERCENTAGES[250 ether] = 90;

        matrixNodes[1] = MatrixNode({
            id: 1,
            user: _rootId,
            parent: 0,
            leftChild: 0,
            rightChild: 0,
            depth: 1,
            leftCount: 0,
            rightCount: 0,
            position: 0,
            exists: true
        });

        users[_rootId] = User({
            currentPacket: 250 ether,
            referrer: address(0),
            placementId: 1,
            matrixBalance: 0,
            poolBalance: 0,
            totalEarned: 0,
            registrationTime: block.timestamp
        });

        isRegistered[_rootId] = true;
        totalUsers = 1;
        lastPoolDistribution = block.timestamp;
    }

    // ========== МОДИФИКАТОРЫ ==========
    modifier onlyOperator() {
        require(hasRole(OPERATOR_ROLE, msg.sender), "Not operator");
        _;
    }

    modifier onlyMultisig() {
        require(hasRole(MULTISIG_ROLE, msg.sender), "Not multisig");
        _;
    }

    // ========== РЕГИСТРАЦИЯ И АКТИВАЦИЯ ==========
    function register(address _referrer) external {
        require(!isRegistered[msg.sender], "Already registered");
        require(_referrer == address(0) || isRegistered[_referrer], "Invalid referrer");

        users[msg.sender] = User({
            currentPacket: 0,
            referrer: _referrer,
            placementId: 0,
            matrixBalance: 0,
            poolBalance: 0,
            totalEarned: 0,
            registrationTime: block.timestamp
        });

        isRegistered[msg.sender] = true;
        totalUsers++;

        emit UserRegistered(msg.sender, _referrer);
    }

    function activatePacket(uint256 _packetIndex) external nonReentrant {
        require(_packetIndex >= 1 && _packetIndex <= 5, "Invalid packet index");

        User storage user = users[msg.sender];
        uint256 newPacket = PACKETS[_packetIndex];
        uint256 oldPacket = user.currentPacket;

        if (_packetIndex > 1) {
            require(oldPacket == PACKETS[_packetIndex - 1], "Wrong packet sequence");
        } else {
            require(oldPacket == 0, "Wrong packet sequence");
        }

        usdtToken.safeTransferFrom(msg.sender, address(this), newPacket);

        user.currentPacket = newPacket;

        if (newPacket == 50 ether && user.placementId == 0 && user.referrer != address(0)) {
            address sponsor = _findSponsorWithPacket(user.referrer);
            if (sponsor != address(0) && users[sponsor].currentPacket > 0) {
                uint256 placementId = _findPlacementInMatrix(sponsor);
                user.placementId = placementId;
                _placeUserInMatrix(msg.sender, placementId);
            }
        }

        _distributeActivation(msg.sender, newPacket, user.referrer);

        emit PacketActivated(msg.sender, newPacket);
    }

    // ========== МАТРИЦА ==========
    function _findSponsorWithPacket(address _startReferrer) internal view returns (address) {
        address current = _startReferrer;
        while (current != address(0) && users[current].currentPacket == 0) {
            current = users[current].referrer;
        }
        return current;
    }

    function _findPlacementInMatrix(address _sponsor) internal view returns (uint256) {
        User storage sponsor = users[_sponsor];
        require(sponsor.placementId > 0, "Sponsor not in matrix");

        MatrixNode storage sponsorNode = matrixNodes[sponsor.placementId];
        bool goLeft = sponsorNode.leftCount <= sponsorNode.rightCount;
        uint256 startNodeId = goLeft ? sponsorNode.leftChild : sponsorNode.rightChild;

        if (startNodeId == 0) {
            return goLeft ? sponsorNode.id * 2 : sponsorNode.id * 2 + 1;
        }
        return _findFreePlace(startNodeId);
    }

    function _findFreePlace(uint256 _startNodeId) internal view returns (uint256) {
        uint256[] memory queue = new uint256[](BFS_QUEUE_SIZE);
        uint256 front = 0;
        uint256 back = 0;
        queue[back++] = _startNodeId;

        while (front < back && front < BFS_QUEUE_SIZE) {
            uint256 currentNodeId = queue[front++];
            MatrixNode storage node = matrixNodes[currentNodeId];
            if (!node.exists || node.user == address(0)) {
                return currentNodeId;
            }
            if (node.leftChild != 0) queue[back++] = node.leftChild;
            if (node.rightChild != 0) queue[back++] = node.rightChild;
        }

        MatrixNode storage startNode = matrixNodes[_startNodeId];
        uint256 candidate = (1 << (startNode.depth)) + (startNode.position * 2);
        return candidate;
    }

    function _placeUserInMatrix(address _user, uint256 _placementId) internal {
        require(_placementId > 0, "Invalid placement ID");

        if (!matrixNodes[_placementId].exists) {
            _createMatrixNode(_user, _getParentId(_placementId), _placementId, _getDepth(_placementId));
        } else {
            matrixNodes[_placementId].user = _user;
        }
        _updateParentCounters(_placementId, true);
    }

    function _createMatrixNode(address _user, uint256 _parentId, uint256 _id, uint256 _depth) internal {
        uint256 position = _id - (1 << (_depth - 1));

        matrixNodes[_id] = MatrixNode({
            id: _id,
            user: _user,
            parent: _parentId,
            leftChild: 0,
            rightChild: 0,
            depth: _depth,
            leftCount: 0,
            rightCount: 0,
            position: position,
            exists: true
        });

        if (_parentId > 0) {
            MatrixNode storage parent = matrixNodes[_parentId];
            if (_id % 2 == 0) parent.leftChild = _id;
            else parent.rightChild = _id;
        }
    }

    function _updateParentCounters(uint256 _nodeId, bool _increment) internal {
        uint256 currentNodeId = _nodeId;
        while (currentNodeId > 1) {
            MatrixNode storage node = matrixNodes[currentNodeId];
            MatrixNode storage parent = matrixNodes[node.parent];

            if (currentNodeId % 2 == 0) {
                if (_increment) parent.leftCount++;
                else parent.leftCount--;
            } else {
                if (_increment) parent.rightCount++;
                else parent.rightCount--;
            }
            currentNodeId = node.parent;
        }
    }

    function _getParentId(uint256 _nodeId) internal pure returns (uint256) {
        return _nodeId / 2;
    }

    function _getDepth(uint256 _nodeId) internal pure returns (uint256) {
        uint256 depth = 0;
        while (_nodeId > 0) {
            _nodeId >>= 1;
            depth++;
        }
        return depth;
    }

    // ========== РАСПРЕДЕЛЕНИЕ ==========
    function _distributeActivation(address _user, uint256 _amount, address _sponsor) internal {
        uint256 referralAmount = _amount * 50 / 100;

        if (_sponsor != address(0)) {
            User storage sponsorData = users[_sponsor];
            if (sponsorData.currentPacket == 0) {
                if (_amount == 50 ether) {
                    usdtToken.safeTransfer(_sponsor, referralAmount);
                    sponsorData.totalEarned += referralAmount;
                    totalReferralPayouts += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, false);
                } else {
                    liquidityPool += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, true);
                }
            } else {
                if (_sponsor == rootId) {
                    liquidityPool += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, true);
                } else {
                    usdtToken.safeTransfer(_sponsor, referralAmount);
                    sponsorData.totalEarned += referralAmount;
                    totalReferralPayouts += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, false);
                }
            }
        } else {
            liquidityPool += referralAmount;
        }

        uint256 activationFee = _amount * 2 / 100;
        usdtToken.safeTransfer(developmentFundWallet, activationFee);

        _distributeUpline(_user, _amount, 4);
    }

    function _distributeUpline(address _startUser, uint256 _totalAmount, uint256 _percentPerLevel) internal {
        uint256 amountPerLevel = _totalAmount * _percentPerLevel / 100;
        address current = users[_startUser].referrer;

        for (uint256 level = 1; level <= MAX_REFERRAL_DEPTH; level++) {
            if (current == address(0)) {
                liquidityPool += amountPerLevel * (MAX_REFERRAL_DEPTH - level + 1);
                break;
            }
            User storage upline = users[current];
            if (upline.currentPacket == 0 || current == rootId) {
                liquidityPool += amountPerLevel;
            } else {
                upline.matrixBalance += amountPerLevel;
                upline.totalEarned += amountPerLevel;
                totalMatrixPayouts += amountPerLevel;
                if (upline.matrixBalance >= MIN_WITHDRAW) {
                    matrixClaimQueue.add(current);
                }
                emit MatrixPayout(current, amountPerLevel);
            }
            current = upline.referrer;
        }
    }

    // ========== ВЫВОД ==========
    function claimMatrix() external nonReentrant {
        User storage user = users[msg.sender];
        require(user.matrixBalance >= MIN_WITHDRAW, "Min 10 USDT required");

        uint256 balance = user.matrixBalance;
        uint256 percentage = WITHDRAW_PERCENTAGES[user.currentPacket];
        require(percentage > 0, "Invalid percentage");

        uint256 toWallet = balance * percentage / 100;
        uint256 toReinvest = balance - toWallet;

        user.matrixBalance = 0;
        user.totalEarned += toWallet;

        usdtToken.safeTransfer(msg.sender, toWallet);
        _processReinvest(msg.sender, toReinvest);
        matrixClaimQueue.remove(msg.sender);

        emit MatrixClaimed(msg.sender, toWallet, toReinvest);
    }

    function claimPool() external nonReentrant {
        User storage user = users[msg.sender];
        require(user.poolBalance >= MIN_WITHDRAW, "Min 10 USDT required");

        VipInfo memory vip = vipInfo[msg.sender];
        require(vip.isActive && block.timestamp < vip.expiresAt, "VIP not active");

        uint256 balance = user.poolBalance;
        uint256 toWallet = balance * 90 / 100;
        uint256 toReinvest = balance - toWallet;

        user.poolBalance = 0;
        user.totalEarned += toWallet;
        totalPoolPayouts += toWallet;

        usdtToken.safeTransfer(msg.sender, toWallet);
        _processReinvest(msg.sender, toReinvest);
        poolClaimQueue.remove(msg.sender);

        emit PoolClaimed(msg.sender, toWallet, toReinvest);
    }

    function claimAll() external nonReentrant {
        bool didClaim = false;

        if (users[msg.sender].matrixBalance >= MIN_WITHDRAW) {
            _forceClaimMatrix(msg.sender);
            didClaim = true;
        }

        VipInfo memory vip = vipInfo[msg.sender];
        if (users[msg.sender].poolBalance >= MIN_WITHDRAW &&
            vip.isActive && block.timestamp < vip.expiresAt) {
            _forceClaimPool(msg.sender);
            didClaim = true;
        }

        require(didClaim, "No balance available to claim");
        emit ClaimAll(msg.sender, users[msg.sender].matrixBalance, users[msg.sender].poolBalance);
    }

    function batchClaimAll(address[] calldata _users) external onlyOperator {
        require(_users.length > 0 && _users.length <= BATCH_LIMIT, "Batch size 1-200");

        uint256 matrixCount = 0;
        uint256 poolCount = 0;

        for (uint256 i = 0; i < _users.length; i++) {
            address userAddr = _users[i];
            if (userAddr == address(0)) continue;

            if (users[userAddr].matrixBalance >= MIN_WITHDRAW) {
                _forceClaimMatrix(userAddr);
                matrixCount++;
            }

            VipInfo memory vip = vipInfo[userAddr];
            if (users[userAddr].poolBalance >= MIN_WITHDRAW &&
                vip.isActive && block.timestamp < vip.expiresAt) {
                _forceClaimPool(userAddr);
                poolCount++;
            }
        }

        emit BatchClaimed(_users, matrixCount, poolCount, _users.length);
    }

    function _forceClaimMatrix(address _user) internal {
        User storage user = users[_user];
        if (user.matrixBalance < MIN_WITHDRAW) return;

        uint256 balance = user.matrixBalance;
        uint256 percentage = WITHDRAW_PERCENTAGES[user.currentPacket];
        if (percentage == 0) return;

        uint256 toWallet = balance * percentage / 100;
        uint256 toReinvest = balance - toWallet;

        user.matrixBalance = 0;
        user.totalEarned += toWallet;

        usdtToken.safeTransfer(_user, toWallet);
        _processReinvest(_user, toReinvest);

        emit MatrixClaimed(_user, toWallet, toReinvest);
    }

    function _forceClaimPool(address _user) internal {
        User storage user = users[_user];
        VipInfo memory vip = vipInfo[_user];
        if (user.poolBalance < MIN_WITHDRAW || !vip.isActive || block.timestamp >= vip.expiresAt) return;

        uint256 balance = user.poolBalance;
        uint256 toWallet = balance * 90 / 100;
        uint256 toReinvest = balance - toWallet;

        user.poolBalance = 0;
        user.totalEarned += toWallet;
        totalPoolPayouts += toWallet;

        usdtToken.safeTransfer(_user, toWallet);
        _processReinvest(_user, toReinvest);

        emit PoolClaimed(_user, toWallet, toReinvest);
    }

    function emergencyClaimExpiredPool(address _user) external onlyMultisig {
        User storage user = users[_user];
        VipInfo memory vip = vipInfo[_user];

        require(user.poolBalance >= MIN_WITHDRAW, "Min 10 USDT required");
        require(!vip.isActive || block.timestamp >= vip.expiresAt, "VIP is still active");

        uint256 balance = user.poolBalance;
        uint256 toWallet = balance * 90 / 100;
        uint256 toReinvest = balance - toWallet;

        user.poolBalance = 0;
        user.totalEarned += toWallet;
        totalPoolPayouts += toWallet;

        usdtToken.safeTransfer(_user, toWallet);
        _processReinvest(_user, toReinvest);

        emit PoolClaimed(_user, toWallet, toReinvest);
    }

    function _processReinvest(address _user, uint256 _amount) internal {
        if (_amount == 0) return;

        uint256 reinvestFee = _amount * 2 / 100;
        uint256 gamePool = _amount * 2 / 100;

        usdtToken.safeTransfer(reinvestFeeWallet, reinvestFee);
        usdtToken.safeTransfer(gamePoolWallet, gamePool);

        _distributeUpline(_user, _amount, 8);
    }

    // ========== VIP ==========
    function requestVip(uint256 _starLevel) external {
        require(_starLevel >= 1 && _starLevel <= 5, "Invalid star level");
        require(users[msg.sender].currentPacket >= PACKETS[_starLevel], "Packet too low");

        VipInfo storage vip = vipInfo[msg.sender];
        if (vip.isActive && block.timestamp < vip.expiresAt) {
            require(_starLevel > vip.starLevel, "Higher level required");
        }

        emit VipRequested(msg.sender, _starLevel);
    }

    function confirmVip(address _user, uint256 _starLevel) external onlyOperator {
        require(isRegistered[_user], "User not registered");
        require(_starLevel >= 1 && _starLevel <= 5, "Invalid star level");

        User storage user = users[_user];
        require(user.currentPacket >= PACKETS[_starLevel], "Packet too low");

        VipInfo storage vip = vipInfo[_user];
        if (vip.isActive && vip.starLevel > 0) {
            _removeFromVipList(_user, vip.starLevel);
        }

        vip.starLevel = _starLevel;
        vip.verifiedAt = block.timestamp;
        vip.expiresAt = block.timestamp + VIP_DURATION;
        vip.isActive = true;

        _addToVipList(_user, _starLevel);

        emit VipConfirmed(_user, _starLevel, vip.expiresAt);
    }

    function batchConfirmVip(address[] calldata _users, uint256 _starLevel) external onlyOperator {
        require(_users.length > 0 && _users.length <= BATCH_LIMIT, "Batch size 1-200");
        require(_starLevel >= 1 && _starLevel <= 5, "Invalid star level");

        uint256 successful = 0;
        for (uint256 i = 0; i < _users.length; i++) {
            address userAddr = _users[i];
            if (!isRegistered[userAddr]) continue;

            User storage user = users[userAddr];
            if (user.currentPacket < PACKETS[_starLevel]) continue;

            VipInfo storage vip = vipInfo[userAddr];
            if (vip.isActive && vip.starLevel > 0) {
                _removeFromVipList(userAddr, vip.starLevel);
            }

            vip.starLevel = _starLevel;
            vip.verifiedAt = block.timestamp;
            vip.expiresAt = block.timestamp + VIP_DURATION;
            vip.isActive = true;

            _addToVipList(userAddr, _starLevel);
            successful++;
        }

        emit BatchVipConfirmed(_users, _starLevel, successful);
    }

    function renewVip(address _user) external onlyOperator {
        VipInfo storage vip = vipInfo[_user];
        require(vip.isActive, "VIP not active");
        require(users[_user].currentPacket >= PACKETS[vip.starLevel], "Packet too low");

        vip.verifiedAt = block.timestamp;
        vip.expiresAt = block.timestamp + VIP_DURATION;

        emit VipRenewed(_user, vip.starLevel, vip.expiresAt);
    }

    function revokeVip(address _user) external onlyOperator {
        VipInfo storage vip = vipInfo[_user];
        require(vip.isActive, "VIP not active");

        _removeFromVipList(_user, vip.starLevel);

        vip.isActive = false;
        vip.starLevel = 0;

        emit VipRevoked(_user);
    }

    function setAntiSybilVerified(address _user) external onlyOperator {
        require(isRegistered[_user], "User not registered");
        vipInfo[_user].antiSybilVerified = true;
        emit AntiSybilVerified(_user);
    }

    function _addToVipList(address _user, uint256 _starLevel) internal {
        if (vipIndexInLevel[_user] != 0) return;
        vipByLevel[_starLevel].push(_user);
        vipIndexInLevel[_user] = vipByLevel[_starLevel].length;
    }

    function _removeFromVipList(address _user, uint256 _starLevel) internal {
        uint256 index = vipIndexInLevel[_user];
        if (index == 0) return;

        uint256 lastIndex = vipByLevel[_starLevel].length - 1;
        if (index - 1 < lastIndex) {
            address lastUser = vipByLevel[_starLevel][lastIndex];
            vipByLevel[_starLevel][index - 1] = lastUser;
            vipIndexInLevel[lastUser] = index;
        }

        vipByLevel[_starLevel].pop();
        vipIndexInLevel[_user] = 0;
    }

    // ========== ПУЛ ==========
    function distributePool() public nonReentrant {
        require(block.timestamp >= lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL, "Too early");
        require(liquidityPool > 0, "Pool is empty");

        uint256 totalPool = liquidityPool;
        liquidityPool = 0;
        uint256[5] memory distributedPerLevel;
        uint256 totalDistributed = 0;
        uint256 returnedToPool = 0;

        for (uint256 level = 0; level < 5; level++) {
            uint256 starLevel = level + 1;
            uint256 levelShare = totalPool * POOL_SHARES[level] / 100;
            if (levelShare == 0) continue;

            _cleanExpiredVips(starLevel);

            address[] storage vipList = vipByLevel[starLevel];
            uint256 count = vipList.length;

            if (count == 0) {
                returnedToPool += levelShare;
                continue;
            }

            uint256 processedCount = count > 500 ? 500 : count;
            uint256 amountPerUser = levelShare / count;
            uint256 levelDistributed = 0;

            for (uint256 i = 0; i < processedCount; i++) {
                address userAddr = vipList[i];
                if (users[userAddr].currentPacket >= PACKETS[starLevel]) {
                    users[userAddr].poolBalance += amountPerUser;
                    levelDistributed += amountPerUser;
                    if (users[userAddr].poolBalance >= MIN_WITHDRAW) {
                        poolClaimQueue.add(userAddr);
                    }
                }
            }

            distributedPerLevel[level] = levelDistributed;
            totalDistributed += levelDistributed;

            if (levelShare > levelDistributed) {
                returnedToPool += (levelShare - levelDistributed);
            }
        }

        uint256 reserveAmount = totalPool * 10 / 100;
        usdtToken.safeTransfer(reserveWallet, reserveAmount);

        liquidityPool += returnedToPool;

        uint256 globalRemainder = totalPool - totalDistributed - reserveAmount - returnedToPool;
        if (globalRemainder > 0) liquidityPool += globalRemainder;

        lastPoolDistribution = block.timestamp;
        emit PoolDistributed(totalPool, distributedPerLevel, reserveAmount);
    }

    function _cleanExpiredVips(uint256 _starLevel) internal {
        address[] storage list = vipByLevel[_starLevel];
        uint256 cleaned = 0;

        for (int256 i = int256(list.length) - 1; i >= 0 && cleaned < MAX_VIP_CLEANUP; i--) {
            address userAddr = list[uint256(i)];
            VipInfo storage vip = vipInfo[userAddr];

            if (block.timestamp >= vip.expiresAt || !vip.isActive) {
                _removeFromVipList(userAddr, _starLevel);
                cleaned++;
            }
        }
    }

    function distributePoolBatch(uint256 _level, uint256 _startIndex, uint256 _batchSize) external nonReentrant {
    require(block.timestamp >= lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL, "Too early");
    require(liquidityPool > 0, "Pool is empty");
    require(_level >= 1 && _level <= 5, "Invalid level");
    require(_batchSize > 0 && _batchSize <= 500, "Batch size 1-500");

    uint256 totalPool = liquidityPool;
    uint256 levelShare = totalPool * POOL_SHARES[_level - 1] / 100;
    
    _cleanExpiredVips(_level);
    
    address[] storage vipList = vipByLevel[_level];
    uint256 count = vipList.length;
    require(_startIndex < count, "Invalid start index");
    
    uint256 endIndex = _startIndex + _batchSize;
    if (endIndex > count) endIndex = count;
    
    uint256 amountPerUser = levelShare / count;
    
    for (uint256 i = _startIndex; i < endIndex; i++) {
        address userAddr = vipList[i];
        if (users[userAddr].currentPacket >= PACKETS[_level]) {
            users[userAddr].poolBalance += amountPerUser;
            if (users[userAddr].poolBalance >= MIN_WITHDRAW) {
                poolClaimQueue.add(userAddr);
            }
        }
    }
    
    if (endIndex == count) {
        liquidityPool = 0;
        uint256 reserveAmount = totalPool * 10 / 100;
        usdtToken.safeTransfer(reserveWallet, reserveAmount);
        lastPoolDistribution = block.timestamp;
        
        uint256[5] memory emptyArray;
        emit PoolDistributed(totalPool, emptyArray, reserveAmount);
    }
}
    
    // ========== ФИНАНСОВЫЕ ФУНКЦИИ ==========
    function updateWallets(
        address _reinvestFeeWallet,
        address _gamePoolWallet,
        address _reserveWallet,
        address _developmentFundWallet
    ) external onlyMultisig {
        reinvestFeeWallet = _reinvestFeeWallet;
        gamePoolWallet = _gamePoolWallet;
        reserveWallet = _reserveWallet;
        developmentFundWallet = _developmentFundWallet;
    }

    function emergencyWithdraw(address _token, uint256 _amount) external onlyMultisig {
        require(_amount > 0, "Amount must be > 0");
        IERC20(_token).safeTransfer(msg.sender, _amount);
    }

    function donateToPool(uint256 _amount) external {
        usdtToken.safeTransferFrom(msg.sender, address(this), _amount);
        liquidityPool += _amount;
        emit PoolDonated(msg.sender, _amount);
    }

    // ========== УПРАВЛЕНИЕ РОЛЯМИ ==========
    function grantOperator(address account) external onlyMultisig {
        _grantRole(OPERATOR_ROLE, account);
    }

    function revokeOperator(address account) external onlyMultisig {
        _revokeRole(OPERATOR_ROLE, account);
    }

    // ========== VIEW ==========
    function getUserInfo(address _user) external view returns (
        uint256 currentPacket,
        address referrer,
        uint256 placementId,
        uint256 matrixBalance,
        uint256 poolBalance,
        uint256 totalEarned,
        bool isRegistered_
    ) {
        User memory u = users[_user];
        return (u.currentPacket, u.referrer, u.placementId, u.matrixBalance, u.poolBalance, u.totalEarned, isRegistered[_user]);
    }

    function getMatrixNode(uint256 _nodeId) external view returns (
        address user,
        uint256 parent,
        uint256 leftChild,
        uint256 rightChild,
        uint256 depth,
        uint256 leftCount,
        uint256 rightCount
    ) {
        MatrixNode memory n = matrixNodes[_nodeId];
        return (n.user, n.parent, n.leftChild, n.rightChild, n.depth, n.leftCount, n.rightCount);
    }

    function getPoolInfo() external view returns (
        uint256 poolBalance,
        uint256 nextDistributionTime,
        uint256[5] memory vipCounts,
        uint256[5] memory poolShares
    ) {
        for (uint256 i = 0; i < 5; i++) {
            vipCounts[i] = vipByLevel[i + 1].length;
            poolShares[i] = POOL_SHARES[i];
        }
        return (liquidityPool, lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL, vipCounts, poolShares);
    }

    function getVipInfo(address _user) external view returns (
        uint256 starLevel,
        uint256 verifiedAt,
        uint256 expiresAt,
        uint256 daysLeft,
        bool isActive,
        bool antiSybilVerified,
        uint256 requiredPacket
    ) {
        VipInfo memory v = vipInfo[_user];
        uint256 daysLeft_ = 0;
        if (v.isActive && v.expiresAt > block.timestamp) {
            daysLeft_ = (v.expiresAt - block.timestamp) / 1 days;
        }
        return (v.starLevel, v.verifiedAt, v.expiresAt, daysLeft_, v.isActive, v.antiSybilVerified, PACKETS[v.starLevel]);
    }

    function getVipList(uint256 _starLevel) external view returns (address[] memory) {
        return vipByLevel[_starLevel];
    }

    function getQueueInfo() external view returns (uint256 matrixQueueLength, uint256 poolQueueLength) {
        return (matrixClaimQueue.length(), poolClaimQueue.length());
    }

            // ========== FALLBACK ==========
    receive() external payable { revert("Direct BNB not allowed"); }
    fallback() external { revert("Invalid call"); }
}