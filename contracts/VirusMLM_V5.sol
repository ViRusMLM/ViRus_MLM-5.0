// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VirusMLM V5.0
 * @author Архитектор
 * @notice DeFi MLM система с VIP-распределением пула ликвидности
 * @dev Полное соответствие ТЗ версии 5.1
 */
contract VirusMLM is ReentrancyGuard, Ownable {
    // ========== КОНСТАНТЫ ==========
    uint256 public constant MIN_WITHDRAW = 2 ether; // 2 USDT
    uint256 public constant POOL_DISTRIBUTION_INTERVAL = 1 days;
    uint256 public constant VIP_DURATION = 30 days;
    uint256 public constant MAX_REFERRAL_DEPTH = 12;
    
    // Пакеты в USDT (1 ether = 1 USDT)
    uint256[] public PACKETS = [0, 50 ether, 100 ether, 150 ether, 200 ether, 250 ether];
    
    // Проценты вывода для матричного баланса
    mapping(uint256 => uint256) public WITHDRAW_PERCENTAGES;
    
    // Доли распределения пула по VIP-уровням
    uint256[5] public POOL_SHARES = [21, 33, 15, 12, 9]; // в процентах
    
    // ========== АДРЕСА СИСТЕМЫ ==========
    IERC20 public immutable usdtToken;
    address public reinvestFeeWallet;
    address public gamePoolWallet;
    address public reserveWallet;
    address public rootId;
    address public developmentFundWallet;
    
    // ========== СТРУКТУРЫ ==========
    struct User {
        uint256 currentPacket;      // Текущий пакет (0,50,100,...)
        address referrer;           // Спонсор (address(0) для root)
        uint256 placementId;        // ID в матрице (0 для пакета 0)
        uint256 matrixBalance;      // Баланс матрицы
        uint256 poolBalance;        // Баланс пула
        uint256 totalEarned;        // Всего заработано
        uint256 registrationTime;    // Время регистрации
    }
    
    struct MatrixNode {
        uint256 id;                 // Уникальный ID
        address user;               // Владелец (address(0) если свободно)
        uint256 parent;             // ID родителя
        uint256 leftChild;          // ID левого потомка
        uint256 rightChild;         // ID правого потомка
        uint256 depth;              // Глубина (root = 1)
        uint256 leftCount;          // Количество узлов в левом поддереве
        uint256 rightCount;         // Количество узлов в правом поддереве
        uint256 position;           // Позиция на уровне (0-based)
        bool exists;                // Существует ли узел
    }
    
    struct VipInfo {
        uint256 starLevel;           // 1-5 (соответствует пакету)
        uint256 verifiedAt;          // Время последнего подтверждения
        uint256 expiresAt;           // Время истечения (+30 дней)
        bool antiSybilVerified;      // Анти-мультиаккаунт проверка (один раз)
        bool isActive;               // Активен ли сейчас
    }
    
    // ========== ХРАНИЛИЩЕ ==========
    mapping(address => User) public users;
    mapping(uint256 => MatrixNode) public matrixNodes;
    mapping(address => bool) public isRegistered;
    mapping(address => VipInfo) public vipInfo;
    
    // Списки VIP по уровням (для быстрого распределения)
    mapping(uint256 => address[]) private vipByLevel;
    mapping(address => uint256) private vipIndexInLevel; // для удаления
    
    // Очереди для Keeper
    address[] private matrixClaimQueue;
    address[] private poolClaimQueue;
    
    // Статистика
    uint256 public totalUsers;
    uint256 public nextNodeId = 2;
    uint256 public liquidityPool;
    uint256 public lastPoolDistribution;
    uint256 public totalMatrixPayouts;
    uint256 public totalPoolPayouts;
    uint256 public totalReferralPayouts;
    
    // Фазы управления
    enum GovernancePhase { SINGLE_OWNER, TRANSITION, MULTISIG }
    GovernancePhase public currentPhase;
    address public pendingMultisig;
    uint256 public multisigTransitionTime;
    uint256 public immutable deploymentTime;
    
    // ========== СОБЫТИЯ ==========
    event UserRegistered(address indexed user, address indexed referrer, uint256 placementId);
    event PacketActivated(address indexed user, uint256 packet, uint256 time);
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
    event GovernancePhaseChanged(GovernancePhase oldPhase, GovernancePhase newPhase);
    event MultisigTransitionStarted(address multisigAddress, uint256 completionTime);
    event MultisigTransitionCompleted(address multisigAddress, uint256 time);
    
    // ========== МОДИФИКАТОРЫ ==========
    modifier onlyOwnerOrMultisig() {
        if (currentPhase == GovernancePhase.SINGLE_OWNER) {
            require(msg.sender == owner(), "Not owner");
        } else if (currentPhase == GovernancePhase.MULTISIG) {
            require(msg.sender == owner(), "Not multisig");
        } else {
            require(msg.sender == owner() || msg.sender == pendingMultisig, "Not authorized");
        }
        _;
    }
    
    modifier onlyRegistered() {
        require(isRegistered[msg.sender], "Not registered");
        _;
    }
    
    modifier onlyActiveUser() {
        require(users[msg.sender].currentPacket > 0, "Not active");
        _;
    }
    
    // ========== КОНСТРУКТОР ==========
    constructor(
        address _usdtToken,
        address _reinvestFeeWallet,
        address _gamePoolWallet,
        address _reserveWallet,
        address _rootId,
        address _developmentFundWallet
    ) Ownable(msg.sender) {
        require(_usdtToken != address(0), "Invalid USDT address");
        require(_reinvestFeeWallet != address(0), "Invalid reinvest wallet");
        require(_gamePoolWallet != address(0), "Invalid game pool wallet");
        require(_reserveWallet != address(0), "Invalid reserve wallet");
        require(_rootId != address(0), "Invalid root ID");
        require(_developmentFundWallet != address(0), "Invalid dev fund wallet");
        
        usdtToken = IERC20(_usdtToken);
        reinvestFeeWallet = _reinvestFeeWallet;
        gamePoolWallet = _gamePoolWallet;
        reserveWallet = _reserveWallet;
        rootId = _rootId;
        developmentFundWallet = _developmentFundWallet;
        
        // Инициализация процентов вывода
        WITHDRAW_PERCENTAGES[50 ether] = 50;
        WITHDRAW_PERCENTAGES[100 ether] = 60;
        WITHDRAW_PERCENTAGES[150 ether] = 70;
        WITHDRAW_PERCENTAGES[200 ether] = 80;
        WITHDRAW_PERCENTAGES[250 ether] = 90;
        
        // Инициализация корневого узла матрицы
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
        
        // Регистрация rootId
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
        deploymentTime = block.timestamp;
        currentPhase = GovernancePhase.SINGLE_OWNER;
    }
    
    // ========== РЕГИСТРАЦИЯ ==========
    
    /**
     * @notice Регистрация нового пользователя
     * @param _referrer Адрес спонсора
     */
    function register(address _referrer) external {
        require(!isRegistered[msg.sender], "Already registered");
        require(_referrer == address(0) || isRegistered[_referrer], "Invalid referrer");
        
        uint256 placementId = 0;
        
        // Если спонсор указан и имеет пакет >0, ищем место в матрице
        if (_referrer != address(0) && users[_referrer].currentPacket > 0) {
            placementId = _findPlacementInMatrix(_referrer);
            if (placementId > 0) {
                _placeUserInMatrix(msg.sender, placementId);
            }
        }
        
        users[msg.sender] = User({
            currentPacket: 0,
            referrer: _referrer,
            placementId: placementId,
            matrixBalance: 0,
            poolBalance: 0,
            totalEarned: 0,
            registrationTime: block.timestamp
        });
        
        isRegistered[msg.sender] = true;
        totalUsers++;
        
        emit UserRegistered(msg.sender, _referrer, placementId);
    }
    
    // ========== АКТИВАЦИЯ ПАКЕТОВ ==========
    
    /**
     * @notice Активация/апгрейд пакета
     * @param _packetIndex Индекс пакета (1-5)
     */
    function activatePacket(uint256 _packetIndex) external nonReentrant onlyRegistered {
        require(_packetIndex >= 1 && _packetIndex <= 5, "Invalid packet index");
        
        User storage user = users[msg.sender];
        uint256 newPacket = PACKETS[_packetIndex];
        uint256 oldPacket = user.currentPacket;
        
        // Проверка последовательности
        if (_packetIndex > 1) {
            require(oldPacket == PACKETS[_packetIndex - 1], "Wrong packet sequence");
        } else {
            require(oldPacket == 0, "Already have packet");
        }
        
        // Полная оплата пакета
        require(
            usdtToken.transferFrom(msg.sender, address(this), newPacket),
            "USDT transfer failed"
        );
        
        // Обновление пакета пользователя
        user.currentPacket = newPacket;
        
        // Если это первый платный пакет и нет места в матрице
        if (newPacket == 50 ether && user.placementId == 0 && user.referrer != address(0)) {
            address sponsor = _findSponsorWithPacket(user.referrer);
            if (sponsor != address(0) && users[sponsor].currentPacket > 0) {
                uint256 placementId = _findPlacementInMatrix(sponsor);
                user.placementId = placementId;
                _placeUserInMatrix(msg.sender, placementId);
            }
        }
        
        // Распределение средств
        _distributeActivation(msg.sender, newPacket, user.referrer);
        
        emit PacketActivated(msg.sender, newPacket, block.timestamp);
    }
    
    /**
     * @notice Поиск спонсора с пакетом >0 для размещения в матрице
     */
    function _findSponsorWithPacket(address _startReferrer) internal view returns (address) {
        address current = _startReferrer;
        while (current != address(0) && users[current].currentPacket == 0) {
            current = users[current].referrer;
        }
        return current;
    }
    
    /**
     * @notice Распределение средств при активации пакета
     */
    function _distributeActivation(address _user, uint256 _amount, address _sponsor) internal {
        // 1. Реферальная выплата (50%)
        uint256 referralAmount = _amount * 50 / 100;
        
        if (_sponsor != address(0)) {
            User storage sponsorData = users[_sponsor];
            
            if (sponsorData.currentPacket == 0) {
                // Спонсор с пакетом 0
                if (_amount == 50 ether) {
                    // Только с активации пакета 50
                    _safeTransfer(_sponsor, referralAmount);
                    sponsorData.totalEarned += referralAmount;
                    totalReferralPayouts += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, false);
                } else {
                    // С апгрейдов (пакеты 100-250) → в пул
                    liquidityPool += referralAmount;
                    emit ReferralPayout(_sponsor, _user, referralAmount, true);
                }
            } else {
                // Обычный спонсор
                _safeTransfer(_sponsor, referralAmount);
                sponsorData.totalEarned += referralAmount;
                totalReferralPayouts += referralAmount;
                emit ReferralPayout(_sponsor, _user, referralAmount, false);
            }
        } else {
            // Нет спонсора (только для root, но root не активирует пакеты)
            liquidityPool += referralAmount;
        }
        
        // 2. Комиссия активации (2%)
        uint256 activationFee = _amount * 2 / 100;
        usdtToken.transfer(developmentFundWallet, activationFee);
        
        // 3. Матричное распределение (48%)
        uint256 matrixAmount = _amount * 48 / 100;
        _distributeUpline(_user, matrixAmount, 4);
    }
    
    /**
     * @notice Распределение вверх по реферальной цепочке
     * @param _percentPerLevel Процент на уровень (4% для активации, 8% для реинвеста)
     */
    function _distributeUpline(address _startUser, uint256 _totalAmount, uint256 _percentPerLevel) internal {
        address currentUser = _startUser;
        uint256 amountPerLevel = _totalAmount * _percentPerLevel / 100;
        uint256 distributed = 0;
        
        for (uint256 i = 0; i < MAX_REFERRAL_DEPTH; i++) {
            User storage upline = users[currentUser];
            
            // Достигли верха цепочки
            if (upline.referrer == address(0)) break;
            
            currentUser = upline.referrer;
            User storage rewardUser = users[currentUser];
            
            // Пропускаем пользователей с пакетом 0
            if (rewardUser.currentPacket == 0) continue;
            
            // Корневой ID → всё в пул
            if (currentUser == rootId) {
                liquidityPool += amountPerLevel;
            } else {
                rewardUser.matrixBalance += amountPerLevel;
                rewardUser.totalEarned += amountPerLevel;
                totalMatrixPayouts += amountPerLevel;
                
                // Добавляем в очередь на вывод
                if (rewardUser.matrixBalance >= MIN_WITHDRAW) {
                    _addToMatrixClaimQueue(currentUser);
                }
                
                emit MatrixPayout(currentUser, amountPerLevel);
            }
            
            distributed += amountPerLevel;
        }
        
        // Остаток в пул ликвидности
        if (_totalAmount > distributed) {
            liquidityPool += (_totalAmount - distributed);
        }
    }
    
    // ========== ВЫВОД СРЕДСТВ ==========
    
    /**
     * @notice Вывод матричного баланса
     */
    function claimMatrix() external nonReentrant onlyActiveUser {
        User storage user = users[msg.sender];
        require(user.matrixBalance >= MIN_WITHDRAW, "Min 2 USDT required");
        
        uint256 balance = user.matrixBalance;
        uint256 percentage = WITHDRAW_PERCENTAGES[user.currentPacket];
        require(percentage > 0, "Invalid percentage");
        
        uint256 toWallet = balance * percentage / 100;
        uint256 toReinvest = balance - toWallet;
        
        user.matrixBalance = 0;
        user.totalEarned += toWallet;
        
        // Вывод на кошелек
        usdtToken.transfer(msg.sender, toWallet);
        
        // Реинвест
        _processReinvest(msg.sender, toReinvest);
        
        // Удаляем из очереди
        _removeFromMatrixClaimQueue(msg.sender);
        
        emit MatrixClaimed(msg.sender, toWallet, toReinvest);
    }
    
    /**
     * @notice Вывод баланса пула
     */
    function claimPool() external nonReentrant onlyActiveUser {
        User storage user = users[msg.sender];
        require(user.poolBalance >= MIN_WITHDRAW, "Min 2 USDT required");
        
        // Проверка активного VIP
        VipInfo memory vip = vipInfo[msg.sender];
        require(vip.isActive && block.timestamp < vip.expiresAt, "VIP not active");
        
        uint256 balance = user.poolBalance;
        uint256 toWallet = balance * 90 / 100; // 90% на кошелек
        uint256 toReinvest = balance - toWallet; // 10% реинвест
        
        user.poolBalance = 0;
        user.totalEarned += toWallet;
        totalPoolPayouts += toWallet;
        
        // Вывод на кошелек
        usdtToken.transfer(msg.sender, toWallet);
        
        // Реинвест
        _processReinvest(msg.sender, toReinvest);
        
        // Удаляем из очереди
        _removeFromPoolClaimQueue(msg.sender);
        
        emit PoolClaimed(msg.sender, toWallet, toReinvest);
    }
    
    /**
     * @notice Обработка реинвеста
     */
    function _processReinvest(address _user, uint256 _amount) internal {
        if (_amount == 0) return;
        
        // Комиссия реинвеста (2%)
        uint256 reinvestFee = _amount * 2 / 100;
        usdtToken.transfer(reinvestFeeWallet, reinvestFee);
        
        // Игровой пул (2%)
        uint256 gamePool = _amount * 2 / 100;
        usdtToken.transfer(gamePoolWallet, gamePool);
        
        // Матричное распределение (96%)
        uint256 matrixAmount = _amount * 96 / 100;
        _distributeUpline(_user, matrixAmount, 8);
    }
    
    // ========== VIP-СИСТЕМА ==========
    
    /**
     * @notice Запрос на получение VIP-статуса
     * @param _starLevel Уровень VIP (1-5)
     */
    function requestVip(uint256 _starLevel) external onlyActiveUser {
        require(_starLevel >= 1 && _starLevel <= 5, "Invalid star level");
        
        User storage user = users[msg.sender];
        uint256 requiredPacket = PACKETS[_starLevel];
        require(user.currentPacket >= requiredPacket, "Packet too low");
        
        VipInfo storage vip = vipInfo[msg.sender];
        
        // Проверяем, нет ли уже активного VIP (нельзя запросить новый, пока активен старый)
        if (vip.isActive && block.timestamp < vip.expiresAt) {
            // Можно запросить только если новый уровень выше
            require(_starLevel > vip.starLevel, "Higher level required");
        }
        
        emit VipRequested(msg.sender, _starLevel);
    }
    
    /**
     * @notice Подтверждение VIP-статуса (только админ)
     * @param _user Адрес пользователя
     * @param _starLevel Уровень VIP
     */
    function confirmVip(address _user, uint256 _starLevel) external onlyOwnerOrMultisig {
        require(isRegistered[_user], "User not registered");
        require(_starLevel >= 1 && _starLevel <= 5, "Invalid star level");
        
        User storage user = users[_user];
        uint256 requiredPacket = PACKETS[_starLevel];
        require(user.currentPacket >= requiredPacket, "Packet too low");
        
        VipInfo storage vip = vipInfo[_user];
        
        // Если был активный VIP, удаляем из старого списка
        if (vip.isActive && vip.starLevel > 0) {
            _removeFromVipList(_user, vip.starLevel);
        }
        
        // Устанавливаем новый VIP
        vip.starLevel = _starLevel;
        vip.verifiedAt = block.timestamp;
        vip.expiresAt = block.timestamp + VIP_DURATION;
        vip.isActive = true;
        // antiSybilVerified сохраняется
        
        // Добавляем в список по уровню
        _addToVipList(_user, _starLevel);
        
        emit VipConfirmed(_user, _starLevel, vip.expiresAt);
    }
    
    /**
     * @notice Продление VIP-статуса (без изменения уровня)
     */
    function renewVip(address _user) external onlyOwnerOrMultisig {
        VipInfo storage vip = vipInfo[_user];
        require(vip.isActive, "VIP not active");
        require(users[_user].currentPacket >= PACKETS[vip.starLevel], "Packet too low");
        
        vip.verifiedAt = block.timestamp;
        vip.expiresAt = block.timestamp + VIP_DURATION;
        
        emit VipRenewed(_user, vip.starLevel, vip.expiresAt);
    }
    
    /**
     * @notice Отзыв VIP-статуса
     */
    function revokeVip(address _user) external onlyOwnerOrMultisig {
        VipInfo storage vip = vipInfo[_user];
        require(vip.isActive, "VIP not active");
        
        _removeFromVipList(_user, vip.starLevel);
        
        vip.isActive = false;
        vip.starLevel = 0;
        
        emit VipRevoked(_user);
    }
    
    /**
     * @notice Установка флага анти-мультиаккаунт проверки
     */
    function setAntiSybilVerified(address _user) external onlyOwnerOrMultisig {
        require(isRegistered[_user], "User not registered");
        vipInfo[_user].antiSybilVerified = true;
        emit AntiSybilVerified(_user);
    }
    
    /**
     * @notice Очистка истёкших VIP из списка
     */
    function _cleanExpiredVips(uint256 _starLevel) internal {
        address[] storage list = vipByLevel[_starLevel];
        
        for (int256 i = int256(list.length) - 1; i >= 0; i--) {
            address userAddr = list[uint256(i)];
            VipInfo storage vip = vipInfo[userAddr];
            
            if (block.timestamp >= vip.expiresAt || !vip.isActive) {
                _removeFromVipList(userAddr, _starLevel);
            }
        }
    }
    
    /**
     * @notice Добавление в список VIP
     */
    function _addToVipList(address _user, uint256 _starLevel) internal {
        require(vipIndexInLevel[_user] == 0, "Already in list");
        
        vipByLevel[_starLevel].push(_user);
        vipIndexInLevel[_user] = vipByLevel[_starLevel].length;
    }
    
    /**
     * @notice Удаление из списка VIP
     */
    function _removeFromVipList(address _user, uint256 _starLevel) internal {
        uint256 index = vipIndexInLevel[_user];
        require(index > 0, "Not in list");
        
        uint256 lastIndex = vipByLevel[_starLevel].length - 1;
        
        if (index - 1 < lastIndex) {
            address lastUser = vipByLevel[_starLevel][lastIndex];
            vipByLevel[_starLevel][index - 1] = lastUser;
            vipIndexInLevel[lastUser] = index;
        }
        
        vipByLevel[_starLevel].pop();
        vipIndexInLevel[_user] = 0;
    }
    
    // ========== ПОЖЕРТВОВАНИЯ ==========
    
    /**
     * @notice Пожертвование в пул ликвидности
     */
    function donateToPool(uint256 _amount) external {
        require(usdtToken.transferFrom(msg.sender, address(this), _amount), "Transfer failed");
        liquidityPool += _amount;
        emit PoolDonated(msg.sender, _amount);
    }
    
    // ========== МАТРИЦА ==========
    
    /**
     * @notice Поиск места в матрице для размещения
     */
    function _findPlacementInMatrix(address _sponsor) internal view returns (uint256) {
        User storage sponsor = users[_sponsor];
        require(sponsor.placementId > 0, "Sponsor not in matrix");
        
        MatrixNode storage sponsorNode = matrixNodes[sponsor.placementId];
        
        // Выбор ноги с меньшим количеством ID
        bool goLeft = sponsorNode.leftCount <= sponsorNode.rightCount;
        
        // Поиск свободного места
        uint256 startNodeId = goLeft ? sponsorNode.leftChild : sponsorNode.rightChild;
        
        if (startNodeId == 0) {
            // Нога пустая - создаем первый узел
            return goLeft ? sponsorNode.id * 2 : sponsorNode.id * 2 + 1;
        }
        
        return _findFreePlace(startNodeId);
    }
    
    /**
     * @notice Поиск свободного места BFS
     */
    function _findFreePlace(uint256 _startNodeId) internal view returns (uint256) {
        uint256[] memory queue = new uint256[](256);
        uint256 front = 0;
        uint256 back = 0;
        
        queue[back++] = _startNodeId;
        
        while (front < back && front < 256) {
            uint256 currentNodeId = queue[front++];
            MatrixNode storage node = matrixNodes[currentNodeId];
            
            if (!node.exists || node.user == address(0)) {
                return currentNodeId;
            }
            
            if (node.leftChild != 0) queue[back++] = node.leftChild;
            if (node.rightChild != 0) queue[back++] = node.rightChild;
        }
        
        // Если не нашли, создаём на глубине
        MatrixNode storage startNode = matrixNodes[_startNodeId];
        return (1 << (startNode.depth)) + (startNode.position * 2);
    }
    
    /**
     * @notice Размещение пользователя в матрице
     */
    function _placeUserInMatrix(address _user, uint256 _placementId) internal {
        require(_placementId > 0, "Invalid placement ID");
        
        if (!matrixNodes[_placementId].exists) {
            _createMatrixNode(_user, _getParentId(_placementId), _placementId, _getDepth(_placementId));
        } else {
            matrixNodes[_placementId].user = _user;
        }
        
        _updateParentCounters(_placementId, true);
    }
    
    /**
     * @notice Создание нового узла матрицы
     */
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
            if (_id % 2 == 0) {
                parent.leftChild = _id;
            } else {
                parent.rightChild = _id;
            }
        }
    }
    
    /**
     * @notice Обновление счетчиков у родителей
     */
    function _updateParentCounters(uint256 _nodeId, bool _increment) internal {
        uint256 currentNodeId = _nodeId;
        
        while (currentNodeId > 1) {
            MatrixNode storage node = matrixNodes[currentNodeId];
            MatrixNode storage parent = matrixNodes[node.parent];
            
            if (currentNodeId % 2 == 0) {
                // Левый потомок
                if (_increment) {
                    parent.leftCount++;
                } else {
                    parent.leftCount--;
                }
            } else {
                // Правый потомок
                if (_increment) {
                    parent.rightCount++;
                } else {
                    parent.rightCount--;
                }
            }
            
            currentNodeId = node.parent;
        }
    }

    // ========== ПУЛ ЛИКВИДНОСТИ ==========
    
    /**
     * @notice Распределение пула ликвидности (ежедневно)
     */
    function distributePool() public {
        require(block.timestamp >= lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL, "Too early");
        require(liquidityPool > 0, "Pool is empty");
        
        uint256 totalPool = liquidityPool;
        liquidityPool = 0;
        
        uint256[5] memory distributedPerLevel;
        uint256 totalDistributed = 0;
        
        // Распределение по VIP-уровням
        for (uint256 level = 0; level < 5; level++) {
            uint256 starLevel = level + 1;
            uint256 levelShare = totalPool * POOL_SHARES[level] / 100;
            
            if (levelShare == 0) continue;
            
            // Очищаем истёкшие VIP
            _cleanExpiredVips(starLevel);
            
            address[] storage vipList = vipByLevel[starLevel];
            uint256 count = vipList.length;
            
            if (count == 0) {
                // Нет получателей → возврат в пул
                liquidityPool += levelShare;
                distributedPerLevel[level] = 0;
                continue;
            }
            
            uint256 amountPerUser = levelShare / count;
            uint256 levelDistributed = 0;
            
            for (uint256 i = 0; i < count; i++) {
                address userAddr = vipList[i];
                User storage user = users[userAddr];
                
                // Проверка, что пользователь всё ещё имеет нужный пакет
                if (user.currentPacket >= PACKETS[starLevel]) {
                    user.poolBalance += amountPerUser;
                    levelDistributed += amountPerUser;
                    
                    // Добавляем в очередь на вывод
                    if (user.poolBalance >= MIN_WITHDRAW) {
                        _addToPoolClaimQueue(userAddr);
                    }
                }
            }
            
            distributedPerLevel[level] = levelDistributed;
            totalDistributed += levelDistributed;
            
            // Остаток (из-за округления) возвращаем в пул
            if (levelShare > levelDistributed) {
                liquidityPool += (levelShare - levelDistributed);
            }
        }
        
        // Резерв 10%
        uint256 reserveAmount = totalPool * 10 / 100;
        usdtToken.transfer(reserveWallet, reserveAmount);
        
        // Остаток (если есть) возвращается в пул
        if (totalDistributed + reserveAmount < totalPool) {
            liquidityPool += (totalPool - totalDistributed - reserveAmount);
        }
        
        lastPoolDistribution = block.timestamp;
        
        emit PoolDistributed(totalPool, distributedPerLevel, reserveAmount);
    }
    
    // ========== KEEPER ФУНКЦИИ ==========
    
    /**
     * @notice Проверка необходимости обслуживания
     */
    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        if (matrixClaimQueue.length > 0) {
            upkeepNeeded = true;
            performData = abi.encode("matrix");
            return (upkeepNeeded, performData);
        }
        
        if (block.timestamp >= lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL && liquidityPool > 0) {
            upkeepNeeded = true;
            performData = abi.encode("pool");
            return (upkeepNeeded, performData);
        }
        
        if (poolClaimQueue.length > 0) {
            upkeepNeeded = true;
            performData = abi.encode("claim_pool");
            return (upkeepNeeded, performData);
        }
        
        return (false, "");
    }
    
    /**
     * @notice Выполнение обслуживания
     */
    function performUpkeep(bytes calldata performData) external {
        string memory action = abi.decode(performData, (string));
        
        if (keccak256(abi.encodePacked(action)) == keccak256(abi.encodePacked("matrix"))) {
            _processMatrixClaims();
        } else if (keccak256(abi.encodePacked(action)) == keccak256(abi.encodePacked("pool"))) {
            distributePool();
        } else if (keccak256(abi.encodePacked(action)) == keccak256(abi.encodePacked("claim_pool"))) {
            _processPoolClaims();
        }
    }
    
    /**
     * @notice Обработка очереди матричных выплат
     */
    function _processMatrixClaims() internal {
        uint256 processed = 0;
        uint256 gasLimit = 5000000;
        
        for (uint256 i = 0; i < matrixClaimQueue.length && processed < 50 && gasleft() > gasLimit; i++) {
            address userAddr = matrixClaimQueue[i];
            if (userAddr != address(0) && users[userAddr].matrixBalance >= MIN_WITHDRAW) {
                _forceClaimMatrix(userAddr);
                processed++;
            }
        }
        
        if (processed > 0) {
            _cleanMatrixClaimQueue(processed);
        }
    }
    
    /**
     * @notice Обработка очереди выплат из пула
     */
    function _processPoolClaims() internal {
        uint256 processed = 0;
        uint256 gasLimit = 5000000;
        
        for (uint256 i = 0; i < poolClaimQueue.length && processed < 50 && gasleft() > gasLimit; i++) {
            address userAddr = poolClaimQueue[i];
            if (userAddr != address(0) && users[userAddr].poolBalance >= MIN_WITHDRAW) {
                _forceClaimPool(userAddr);
                processed++;
            }
        }
        
        if (processed > 0) {
            _cleanPoolClaimQueue(processed);
        }
    }
    
    /**
     * @notice Принудительный вывод матричного баланса
     */
    function _forceClaimMatrix(address _user) internal {
        User storage user = users[_user];
        if (user.matrixBalance >= MIN_WITHDRAW) {
            uint256 balance = user.matrixBalance;
            uint256 percentage = WITHDRAW_PERCENTAGES[user.currentPacket];
            
            if (percentage > 0) {
                uint256 toWallet = balance * percentage / 100;
                uint256 toReinvest = balance - toWallet;
                
                user.matrixBalance = 0;
                user.totalEarned += toWallet;
                
                usdtToken.transfer(_user, toWallet);
                _processReinvest(_user, toReinvest);
                
                emit MatrixClaimed(_user, toWallet, toReinvest);
            }
        }
    }
    
    /**
     * @notice Принудительный вывод баланса пула
     */
    function _forceClaimPool(address _user) internal {
        User storage user = users[_user];
        VipInfo memory vip = vipInfo[_user];
        
        if (user.poolBalance >= MIN_WITHDRAW && vip.isActive && block.timestamp < vip.expiresAt) {
            uint256 balance = user.poolBalance;
            uint256 toWallet = balance * 90 / 100;
            uint256 toReinvest = balance - toWallet;
            
            user.poolBalance = 0;
            user.totalEarned += toWallet;
            totalPoolPayouts += toWallet;
            
            usdtToken.transfer(_user, toWallet);
            _processReinvest(_user, toReinvest);
            
            emit PoolClaimed(_user, toWallet, toReinvest);
        }
    }
    
    // ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ОЧЕРЕДЕЙ ==========
    
    function _addToMatrixClaimQueue(address _user) internal {
        for (uint256 i = 0; i < matrixClaimQueue.length; i++) {
            if (matrixClaimQueue[i] == _user) return;
        }
        matrixClaimQueue.push(_user);
    }
    
    function _removeFromMatrixClaimQueue(address _user) internal {
        for (uint256 i = 0; i < matrixClaimQueue.length; i++) {
            if (matrixClaimQueue[i] == _user) {
                matrixClaimQueue[i] = matrixClaimQueue[matrixClaimQueue.length - 1];
                matrixClaimQueue.pop();
                break;
            }
        }
    }
    
    function _cleanMatrixClaimQueue(uint256 _processed) internal {
        if (_processed >= matrixClaimQueue.length) {
            delete matrixClaimQueue;
        } else {
            for (uint256 i = 0; i < matrixClaimQueue.length - _processed; i++) {
                matrixClaimQueue[i] = matrixClaimQueue[i + _processed];
            }
            for (uint256 i = 0; i < _processed; i++) {
                matrixClaimQueue.pop();
            }
        }
    }
    
    function _addToPoolClaimQueue(address _user) internal {
        for (uint256 i = 0; i < poolClaimQueue.length; i++) {
            if (poolClaimQueue[i] == _user) return;
        }
        poolClaimQueue.push(_user);
    }
    
    function _removeFromPoolClaimQueue(address _user) internal {
        for (uint256 i = 0; i < poolClaimQueue.length; i++) {
            if (poolClaimQueue[i] == _user) {
                poolClaimQueue[i] = poolClaimQueue[poolClaimQueue.length - 1];
                poolClaimQueue.pop();
                break;
            }
        }
    }
    
    function _cleanPoolClaimQueue(uint256 _processed) internal {
        if (_processed >= poolClaimQueue.length) {
            delete poolClaimQueue;
        } else {
            for (uint256 i = 0; i < poolClaimQueue.length - _processed; i++) {
                poolClaimQueue[i] = poolClaimQueue[i + _processed];
            }
            for (uint256 i = 0; i < _processed; i++) {
                poolClaimQueue.pop();
            }
        }
    }
    
    function _safeTransfer(address _to, uint256 _amount) internal {
        bool success = usdtToken.transfer(_to, _amount);
        require(success, "Transfer failed");
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
    
    // ========== VIEW-ФУНКЦИИ ==========
    
    function getUserInfo(address _user) external view returns (
        uint256 currentPacket,
        address referrer,
        uint256 placementId,
        uint256 matrixBalance,
        uint256 poolBalance,
        uint256 totalEarned,
        bool isRegistered_
    ) {
        User memory user = users[_user];
        return (
            user.currentPacket,
            user.referrer,
            user.placementId,
            user.matrixBalance,
            user.poolBalance,
            user.totalEarned,
            isRegistered[_user]
        );
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
        MatrixNode memory node = matrixNodes[_nodeId];
        return (
            node.user,
            node.parent,
            node.leftChild,
            node.rightChild,
            node.depth,
            node.leftCount,
            node.rightCount
        );
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
        
        return (
            liquidityPool,
            lastPoolDistribution + POOL_DISTRIBUTION_INTERVAL,
            vipCounts,
            poolShares
        );
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
        VipInfo memory vip = vipInfo[_user];
        uint256 daysLeft_ = 0;
        if (vip.isActive && vip.expiresAt > block.timestamp) {
            daysLeft_ = (vip.expiresAt - block.timestamp) / 1 days;
        }
        
        return (
            vip.starLevel,
            vip.verifiedAt,
            vip.expiresAt,
            daysLeft_,
            vip.isActive,
            vip.antiSybilVerified,
            PACKETS[vip.starLevel]
        );
    }
    
    function getVipList(uint256 _starLevel) external view returns (address[] memory) {
        return vipByLevel[_starLevel];
    }
    
    function getQueueInfo() external view returns (
        uint256 matrixQueueLength,
        uint256 poolQueueLength
    ) {
        return (matrixClaimQueue.length, poolClaimQueue.length);
    }
    
    function getGovernanceInfo() external view returns (
        GovernancePhase phase,
        address currentOwner,
        address pendingMultisigAddress,
        uint256 transitionCompletionTime,
        uint256 daysSinceDeployment
    ) {
        return (
            currentPhase,
            owner(),
            pendingMultisig,
            multisigTransitionTime,
            (block.timestamp - deploymentTime) / 1 days
        );
    }
    
    // ========== АДМИН-ФУНКЦИИ (ФАЗА 1) ==========
    
    /**
     * @notice Обновление адресов кошельков (только фаза 1)
     */
    function updateWallets(
        address _reinvestFeeWallet,
        address _gamePoolWallet,
        address _reserveWallet,
        address _developmentFundWallet
    ) external onlyOwner {
        require(currentPhase == GovernancePhase.SINGLE_OWNER, "Only in phase 1");
        
        reinvestFeeWallet = _reinvestFeeWallet;
        gamePoolWallet = _gamePoolWallet;
        reserveWallet = _reserveWallet;
        developmentFundWallet = _developmentFundWallet;
    }
    
    // ========== УПРАВЛЕНИЕ ФАЗАМИ ==========
    
    /**
     * @notice Инициация перехода на мультисиг
     */
    function initiateMultisigTransition(address _multisigAddress) external onlyOwner {
        require(currentPhase == GovernancePhase.SINGLE_OWNER, "Wrong phase");
        require(block.timestamp >= deploymentTime + 180 days, "Too early (6 months)");
        
        pendingMultisig = _multisigAddress;
        currentPhase = GovernancePhase.TRANSITION;
        multisigTransitionTime = block.timestamp + 180 days; // +6 месяцев
        
        emit MultisigTransitionStarted(_multisigAddress, multisigTransitionTime);
        emit GovernancePhaseChanged(GovernancePhase.SINGLE_OWNER, GovernancePhase.TRANSITION);
    }
    
    /**
     * @notice Завершение перехода на мультисиг
     */
    function completeMultisigTransition() external {
        require(currentPhase == GovernancePhase.TRANSITION, "Wrong phase");
        require(block.timestamp >= multisigTransitionTime, "Transition not complete");
        require(msg.sender == owner() || msg.sender == pendingMultisig, "Not authorized");
        
        _transferOwnership(pendingMultisig);
        currentPhase = GovernancePhase.MULTISIG;
        
        emit MultisigTransitionCompleted(pendingMultisig, block.timestamp);
        emit GovernancePhaseChanged(GovernancePhase.TRANSITION, GovernancePhase.MULTISIG);
    }
    
    // ========== ЭКСТРЕННЫЙ ВЫВОД (ТОЛЬКО МУЛЬТИСИГ) ==========
    
    /**
     * @notice Экстренный вывод токенов (только мультисиг)
     */
    function emergencyWithdraw(address _token, uint256 _amount) external onlyOwnerOrMultisig {
        require(currentPhase != GovernancePhase.SINGLE_OWNER, "Only in multisig phase");
        IERC20(_token).transfer(owner(), _amount);
    }
    
    // ========== FALLBACK ==========
    
    receive() external payable {
        revert("Direct BNB deposits not allowed");
    }
    
    fallback() external {
        revert("Invalid function call");
    }
}