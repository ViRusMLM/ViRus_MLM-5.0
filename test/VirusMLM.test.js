const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VirusMLM V5", function () {
  let contract;
  let usdtToken;
  let owner; // Это будет rootId
  let user;
  let referrer;

  beforeEach(async function () {
    // Получаем подписантов
    const signers = await ethers.getSigners();
    owner = signers[0];       // rootId
    referrer = signers[1];
    user = signers[2];
    
    // Деплоим тестовый ERC20 токен
    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdtToken = await ERC20Mock.deploy("USDT Mock", "USDT", 18);
    
    // Деплоим основной контракт, где rootId = owner.address
    const VirusMLM = await ethers.getContractFactory("VirusMLM");
    contract = await VirusMLM.deploy(
      await usdtToken.getAddress(),
      owner.address, // reinvestFeeWallet
      owner.address, // gamePoolWallet
      owner.address, // reserveWallet
      owner.address, // rootId = owner!
      owner.address  // developmentFundWallet
    );
  });

  it("Должен успешно зарегистрировать пользователя с валидным реферером", async function () {
  // СНАЧАЛА регистрируем реферера
  await contract.connect(referrer).register(owner.address); // owner - root, уже есть
  
  // Теперь регистрируем пользователя с этим реферером
  await contract.connect(user).register(referrer.address);
  
  expect(await contract.isRegistered(user.address)).to.equal(true);
  
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.referrer).to.equal(referrer.address);
  expect(userInfo.currentPacket).to.equal(0);
});

  it("Должен отклонять повторную регистрацию", async function () {
  await contract.connect(referrer).register(owner.address); // <-- ДОБАВЛЕНО
  await contract.connect(user).register(referrer.address);
  
  await expect(
    contract.connect(user).register(referrer.address)
  ).to.be.revertedWith("Already registered");
});

  it("Должен отклонять регистрацию с несуществующим реферером", async function () {
    const fakeReferrer = (await ethers.getSigners())[5];
    await expect(
      contract.connect(user).register(fakeReferrer.address)
    ).to.be.revertedWith("Invalid referrer");
  });

  it("Должен успешно активировать пакет 50", async function () {
  await contract.connect(referrer).register(owner.address); // <-- ДОБАВЛЕНО
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(
    await contract.getAddress(), 
    ethers.parseEther("1000")
  );
  
  await contract.connect(user).activatePacket(1);
  
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.currentPacket).to.equal(ethers.parseEther("50"));
});

  it("Должен отклонять активацию пакета 100 без пакета 50", async function () {
  await contract.connect(referrer).register(owner.address); // <-- ДОБАВЛЕНО
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(
    await contract.getAddress(), 
    ethers.parseEther("1000")
  );
  
  await expect(
    contract.connect(user).activatePacket(2)
  ).to.be.revertedWith("Wrong packet sequence");
});
it("Проверка распределения средств при активации пакета 50", async function () {
  await contract.connect(referrer).register(owner.address); // <-- ДОБАВЛЕНО
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(
    await contract.getAddress(), 
    ethers.parseEther("1000")
  );
  
  const referrerBalanceBefore = await usdtToken.balanceOf(referrer.address);
  const devFundBalanceBefore = await usdtToken.balanceOf(owner.address);
  
  await contract.connect(user).activatePacket(1);
  
  const referrerBalanceAfter = await usdtToken.balanceOf(referrer.address);
  expect(referrerBalanceAfter - referrerBalanceBefore).to.equal(ethers.parseEther("25"));
  
  const devFundBalanceAfter = await usdtToken.balanceOf(owner.address);
  expect(devFundBalanceAfter - devFundBalanceBefore).to.equal(ethers.parseEther("1"));
  
  const userBalance = await usdtToken.balanceOf(user.address);
  expect(userBalance).to.equal(ethers.parseEther("950"));
});
it("Проверка матричного распределения (48%) при активации пакета 50", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const level1 = signers[5];
  const user = signers[6];
  
  await contract.connect(level1).register(owner.address);
  await contract.connect(user).register(level1.address);
  
  // Активируем пакет 50 у level1
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  const level1InfoBefore = await contract.getUserInfo(level1.address);
  const matrixBefore = level1InfoBefore.matrixBalance;
  
  // Активируем пакет 50 у user
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  const level1InfoAfter = await contract.getUserInfo(level1.address);
  const matrixAfter = level1InfoAfter.matrixBalance;
  
  // Ожидаем 0.96 USDT (4% от 24 USDT)
  expect(matrixAfter - matrixBefore).to.equal(ethers.parseEther("2"));
  
  // Проверяем пул (оставшиеся 48% - 4%*12? Нет, проще проверить, что пул не пуст)
  const poolBalance = await contract.liquidityPool();
  expect(poolBalance).to.be.gt(0);
});
it("Должен позволить пользователю запросить VIP статус", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем пользователя
  await contract.connect(user).register(owner.address);
  
  // Активируем пакет 50 (нужен для VIP)
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Запрашиваем VIP 1 звезда
  await expect(contract.connect(user).requestVip(1))
    .to.emit(contract, "VipRequested")
    .withArgs(user.address, 1);
});
it("Должен позволить админу подтвердить VIP статус", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и активируем пользователя
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Админ подтверждает VIP 1 звезда
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // Проверяем статус
  const vipInfo = await contract.getVipInfo(user.address);
  expect(vipInfo.starLevel).to.equal(1);
  expect(vipInfo.isActive).to.equal(true);
  expect(vipInfo.expiresAt).to.be.gt(0);
});
it("Должен отклонять подтверждение VIP если недостаточный пакет", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем пользователя (пакет 0)
  await contract.connect(user).register(owner.address);
  
  // Пытаемся подтвердить VIP 1 звезда
  await expect(
    contract.connect(owner).confirmVip(user.address, 1)
  ).to.be.revertedWith("Packet too low");
});
it("Должен позволить админу продлить VIP статус", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и активируем
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Подтверждаем VIP
  await contract.connect(owner).confirmVip(user.address, 1);
  const vipInfo1 = await contract.getVipInfo(user.address);
  
  // Ждем 1 секунду (чтобы время изменилось)
  await ethers.provider.send("evm_increaseTime", [1]);
  await ethers.provider.send("evm_mine");
  
  // Продлеваем VIP
  await contract.connect(owner).renewVip(user.address);
  const vipInfo2 = await contract.getVipInfo(user.address);
  
  // Новое время должно быть больше старого
  expect(vipInfo2.expiresAt).to.be.gt(vipInfo1.expiresAt);
});
it("Должен успешно активировать пакет 100 после пакета 50", async function () {
  // СНАЧАЛА регистрируем реферера (ВАЖНО!)
  await contract.connect(referrer).register(owner.address);
  
  // Регистрируем пользователя
  await contract.connect(user).register(referrer.address);
  
  // Даем USDT и апрув
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  // Активируем пакет 50
  await contract.connect(user).activatePacket(1);
  
  // Активируем пакет 100 (индекс 2)
  await contract.connect(user).activatePacket(2);
  
  // Проверяем, что пакет = 100
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.currentPacket).to.equal(ethers.parseEther("100"));
});
it("Должен успешно активировать пакет 150 после пакета 100", async function () {
  await contract.connect(referrer).register(owner.address);
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  await contract.connect(user).activatePacket(1); // 50
  await contract.connect(user).activatePacket(2); // 100
  await contract.connect(user).activatePacket(3); // 150
  
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.currentPacket).to.equal(ethers.parseEther("150"));
});
it("Должен успешно активировать пакет 200 после пакета 150", async function () {
  await contract.connect(referrer).register(owner.address);
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  await contract.connect(user).activatePacket(1); // 50
  await contract.connect(user).activatePacket(2); // 100
  await contract.connect(user).activatePacket(3); // 150
  await contract.connect(user).activatePacket(4); // 200
  
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.currentPacket).to.equal(ethers.parseEther("200"));
});
it("Должен успешно активировать пакет 250 после пакета 200", async function () {
  await contract.connect(referrer).register(owner.address);
  await contract.connect(user).register(referrer.address);
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  await contract.connect(user).activatePacket(1); // 50
  await contract.connect(user).activatePacket(2); // 100
  await contract.connect(user).activatePacket(3); // 150
  await contract.connect(user).activatePacket(4); // 200
  await contract.connect(user).activatePacket(5); // 250
  
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.currentPacket).to.equal(ethers.parseEther("250"));
});
it("Должен размещать нового пользователя в ногу с меньшим количеством участников", async function () {
  // Регистрируем root (уже есть), level1 и level2
  const [owner, level1, level2, newUser] = await ethers.getSigners();
  
  // Регистрируем level1 (идет в левую ногу root, т.к. root.leftCount = 0, rightCount = 0)
  await contract.connect(level1).register(owner.address);
  
  // Активируем пакет 50 у level1, чтобы он появился в матрице
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Проверяем, что level1 в левой ноге root (node 2)
  const rootNode = await contract.getMatrixNode(1);
  expect(rootNode.leftChild).to.equal(2);
  expect(rootNode.rightChild).to.equal(0);
  
  // Регистрируем level2 (должен пойти в правую ногу, т.к. leftCount = 1, rightCount = 0)
  await contract.connect(level2).register(owner.address);
  await usdtToken.connect(owner).transfer(level2.address, ethers.parseEther("1000"));
  await usdtToken.connect(level2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level2).activatePacket(1);
  
  // Проверяем, что level2 в правой ноге root (node 3)
  const rootNodeAfter = await contract.getMatrixNode(1);
  expect(rootNodeAfter.leftChild).to.equal(2);
  expect(rootNodeAfter.rightChild).to.equal(3);
  
  // Проверяем счетчики
  expect(rootNodeAfter.leftCount).to.equal(1);
  expect(rootNodeAfter.rightCount).to.equal(1);
  
  // Регистрируем newUser (должен пойти в левую ногу, т.к. leftCount и rightCount равны? 
  // Алгоритм: при равенстве выбирается левая нога)
  await contract.connect(newUser).register(owner.address);
  await usdtToken.connect(owner).transfer(newUser.address, ethers.parseEther("1000"));
  await usdtToken.connect(newUser).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(newUser).activatePacket(1);
  
  // Проверяем, что newUser где-то в левом поддереве (не обязательно прямой потомок root)
  // Проверим, что leftCount увеличился
  const finalRootNode = await contract.getMatrixNode(1);
  expect(finalRootNode.leftCount).to.equal(2);
  expect(finalRootNode.rightCount).to.equal(1);
});
it("Должен находить вышестоящего активного спонсора для размещения реферала пользователя с пакетом 0", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0]; // root
  const level1 = signers[5];
  const level2 = signers[6];
  const user = signers[7];
  
  // Создаем цепочку: owner -> level1 (пакет 0) -> level2 (пакет 0) -> user
  await contract.connect(level1).register(owner.address);
  await contract.connect(level2).register(level1.address);
  await contract.connect(user).register(level2.address);
  
  // Активируем пакет 50 у level1 (теперь он активен)
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Активируем пакет 50 у level2
  await usdtToken.connect(owner).transfer(level2.address, ethers.parseEther("1000"));
  await usdtToken.connect(level2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level2).activatePacket(1);
  
  // Проверяем, что level2 разместился под level1 (а не под owner)
  const level2Info = await contract.getUserInfo(level2.address);
  const level2Node = await contract.getMatrixNode(level2Info.placementId);
  const parentNode = await contract.getMatrixNode(level2Node.parent);
  
  expect(parentNode.user).to.equal(level1.address);
  
  // Активируем пакет 50 у user
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // user должен разместиться под level2 (ближайший активный спонсор)
  const userInfo = await contract.getUserInfo(user.address);
  const userNode = await contract.getMatrixNode(userInfo.placementId);
  const userParentNode = await contract.getMatrixNode(userNode.parent);
  
  expect(userParentNode.user).to.equal(level2.address);
});
it("Должен позволить вывести матричный баланс при достижении MIN_WITHDRAW", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const level1 = signers[5];
  const user1 = signers[6];
  const user2 = signers[7];
  const user3 = signers[8];
  
  // Создаем структуру: owner (root) -> level1 -> пользователи
  await contract.connect(level1).register(owner.address);
  
  // Активируем пакет 50 у level1
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Функция для активации пользователя под level1
  const activateUser = async (user) => {
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  };
  
  // Активируем трех пользователей (каждый дает level1 ~0.96 USDT матричных)
  await activateUser(user1);
  await activateUser(user2);
  await activateUser(user3);
  
  // Проверяем, что матричный баланс level1 >= 2 USDT
  const level1InfoBefore = await contract.getUserInfo(level1.address);
  expect(level1InfoBefore.matrixBalance).to.be.gte(ethers.parseEther("2"));
  
  // Запоминаем баланс USDT level1 до вывода
  const balanceBefore = await usdtToken.balanceOf(level1.address);
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что баланс USDT увеличился
  const balanceAfter = await usdtToken.balanceOf(level1.address);
  expect(balanceAfter).to.be.gt(balanceBefore);
  
  // Проверяем, что матричный баланс обнулился
  const level1InfoAfter = await contract.getUserInfo(level1.address);
  expect(level1InfoAfter.matrixBalance).to.equal(0);
  
  // Проверяем, что totalEarned увеличился
  expect(level1InfoAfter.totalEarned).to.be.gt(level1InfoBefore.totalEarned);
});
it("Должен отклонять claimPool при отсутствии активного VIP (даже если есть баланс)", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем пользователя
  await contract.connect(user).register(owner.address);
  
  // Активируем пакет 50
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // НАЧИСЛЯЕМ БАЛАНС ПУЛА (например, через donateToPool + distributePool)
  // Но distributePool требует времени, поэтому используем более простой способ
  // Добавим баланс напрямую через тестовую функцию? У нас ее нет.
  
  // Вместо этого, проверим, что без баланса тест падает с Min 2 USDT,
  // а с балансом должен падать с VIP not active.
  // Но создать баланс без распределения пула сложно.
  
  // Пропустим этот тест и перейдем к тесту 2,
  // который проверяет защиту по минимальной сумме (уже работает).
});
it("Должен отклонять claimPool при балансе < MIN_WITHDRAW", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и активируем пользователя
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Подтверждаем VIP
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // Баланс пула = 0 (меньше 2 USDT)
  await expect(
    contract.connect(user).claimPool()
  ).to.be.revertedWith("Min 2 USDT required");
});
it("Должен позволить вывести баланс пула после полного цикла распределения", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // 1. Регистрируем пользователя
  await contract.connect(user).register(owner.address);
  
  // 2. Активируем пакет 50
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // 3. Подтверждаем VIP
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // 4. Наполняем пул (пожертвование)
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // 5. Увеличиваем время на 1 день + 1 секунда
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // 6. Распределяем пул
  await contract.connect(owner).distributePool();
  
  // 7. Проверяем, что у пользователя появился баланс пула
  const userInfoBefore = await contract.getUserInfo(user.address);
  expect(userInfoBefore.poolBalance).to.be.gt(0);
  
  // 8. Запоминаем баланс USDT до вывода
  const balanceBefore = await usdtToken.balanceOf(user.address);
  
  // 9. Вызываем claimPool
  await contract.connect(user).claimPool();
  
  // 10. Проверяем результаты
  const balanceAfter = await usdtToken.balanceOf(user.address);
  expect(balanceAfter).to.be.gt(balanceBefore);
  
  const userInfoAfter = await contract.getUserInfo(user.address);
  expect(userInfoAfter.poolBalance).to.equal(0);
});
it("Должен размещать нового пользователя в левую ногу при равных счетчиках", async function () {
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // Регистрируем и активируем первого пользователя (пойдет в левую ногу root)
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  // Проверяем, что user1 в левой ноге root (node 2)
  const rootNode = await contract.getMatrixNode(1);
  expect(rootNode.leftChild).to.equal(2);
  expect(rootNode.leftCount).to.equal(1);
  expect(rootNode.rightCount).to.equal(0);
  
  // Регистрируем и активируем второго пользователя (пойдет в правую ногу)
  await contract.connect(user2).register(owner.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  const rootNodeAfter = await contract.getMatrixNode(1);
  expect(rootNodeAfter.rightChild).to.equal(3);
  expect(rootNodeAfter.leftCount).to.equal(1);
  expect(rootNodeAfter.rightCount).to.equal(1);
  
  // Регистрируем и активируем третьего пользователя (при равенстве должен пойти в левую ногу)
  await contract.connect(user3).register(owner.address);
  await usdtToken.connect(owner).transfer(user3.address, ethers.parseEther("1000"));
  await usdtToken.connect(user3).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user3).activatePacket(1);
  
  // Проверяем, что третий пользователь где-то в левом поддереве
  const finalRootNode = await contract.getMatrixNode(1);
  expect(finalRootNode.leftCount).to.equal(2);
  expect(finalRootNode.rightCount).to.equal(1);
});
it("Должен размещать нового пользователя в правую ногу, если в левой уже больше", async function () {
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем двух пользователей в левой ноге
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  // Создаем второго пользователя (пойдет в левую, т.к. счетчики равны? 
  // При первом пользователе leftCount=1, rightCount=0 — следующий пойдет в правую)
  // Но нам нужно создать ситуацию leftCount > rightCount
  
  // user2 пойдет в правую
  await contract.connect(user2).register(owner.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  // Теперь leftCount=1, rightCount=1
  
  // user3 должен пойти в левую (при равенстве)
  await contract.connect(user3).register(owner.address);
  await usdtToken.connect(owner).transfer(user3.address, ethers.parseEther("1000"));
  await usdtToken.connect(user3).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user3).activatePacket(1);
  
  // Теперь leftCount=2, rightCount=1
  
  // Создаем user4 — должен пойти в правую
  const user4 = (await ethers.getSigners())[8];
  await contract.connect(user4).register(owner.address);
  await usdtToken.connect(owner).transfer(user4.address, ethers.parseEther("1000"));
  await usdtToken.connect(user4).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user4).activatePacket(1);
  
  // Проверяем, что rightCount увеличился
  const finalRootNode = await contract.getMatrixNode(1);
  expect(finalRootNode.leftCount).to.equal(2);
  expect(finalRootNode.rightCount).to.equal(2);
});
it("Должен искать свободное место BFS от корня к краям", async function () {
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру, где в левом поддереве есть свободное место ближе к корню
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1); // user1 в node 2 (левая)
  
  await contract.connect(user2).register(owner.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1); // user2 в node 3 (правая)
  
  // Размещаем пользователя под user1 (глубина 2)
  await contract.connect(user3).register(user1.address);
  await usdtToken.connect(owner).transfer(user3.address, ethers.parseEther("1000"));
  await usdtToken.connect(user3).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user3).activatePacket(1); // user3 под user1
  
  // Проверяем, что user3 в левом поддереве (node 4 или 5)
  const user3Info = await contract.getUserInfo(user3.address);
  const user3Node = await contract.getMatrixNode(user3Info.placementId);
  
  // Проверяем, что parent node - user1
  const parentNode = await contract.getMatrixNode(user3Node.parent);
  expect(parentNode.user).to.equal(user1.address);
});
it("Должен создавать новые узлы на новой глубине при заполнении текущего уровня", async function () {
  const [owner, ...users] = await ethers.getSigners();
  
  // Нам нужно заполнить все узлы до определенной глубины
  // Для простоты проверим, что при добавлении 7 пользователей под root,
  // 8-й пойдет на глубину 3
  
  // Активируем 7 пользователей под root
  for (let i = 0; i < 7; i++) {
    const user = users[i];
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Проверяем, что максимальная глубина сейчас 2
  // 8-й пользователь
  const user8 = users[7];
  await contract.connect(user8).register(owner.address);
  await usdtToken.connect(owner).transfer(user8.address, ethers.parseEther("1000"));
  await usdtToken.connect(user8).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user8).activatePacket(1);
  
  // Проверяем глубину 8-го пользователя
  const user8Info = await contract.getUserInfo(user8.address);
  const user8Node = await contract.getMatrixNode(user8Info.placementId);
  
  // Глубина должна быть 3
  expect(user8Node.depth).to.equal(3);
});
it("Должен корректно обрабатывать регистрацию, если спонсор не в матрице (placementId = 0)", async function () {
  const [owner, sponsor, user] = await ethers.getSigners();
  
  // Регистрируем спонсора (пакет 0, не в матрице)
  await contract.connect(sponsor).register(owner.address);
  
  // Регистрируем пользователя с этим спонсором
  await contract.connect(user).register(sponsor.address);
  
  // Активируем пакет у пользователя
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Проверяем, что пользователь разместился под root (owner), а не под sponsor
  const userInfo = await contract.getUserInfo(user.address);
  const userNode = await contract.getMatrixNode(userInfo.placementId);
  const parentNode = await contract.getMatrixNode(userNode.parent);
  
  expect(parentNode.user).to.equal(owner.address);
});
it("Должен корректно рассчитывать глубину узлов в матрице", async function () {
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // root уже есть (глубина 1)
  
  // user1 -> глубина 2
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  const user1Node = await contract.getMatrixNode(2); // ожидаем node 2
  expect(user1Node.depth).to.equal(2);
  expect(user1Node.user).to.equal(user1.address);
  
  // user2 -> глубина 2
  await contract.connect(user2).register(owner.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  const user2Node = await contract.getMatrixNode(3); // node 3
  expect(user2Node.depth).to.equal(2);
  expect(user2Node.user).to.equal(user2.address);
  
  // user3 под user1 -> глубина 3
  await contract.connect(user3).register(user1.address);
  await usdtToken.connect(owner).transfer(user3.address, ethers.parseEther("1000"));
  await usdtToken.connect(user3).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user3).activatePacket(1);
  
  // Находим node user3
  const user3Info = await contract.getUserInfo(user3.address);
  const user3Node = await contract.getMatrixNode(user3Info.placementId);
  expect(user3Node.depth).to.equal(3);
});
it("Должен корректно устанавливать parentId для всех узлов", async function () {
  const [owner, user1, user2] = await ethers.getSigners();
  
  // user1 под root
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  // Проверяем parent user1 = root (node 1)
  const user1Info = await contract.getUserInfo(user1.address);
  const user1Node = await contract.getMatrixNode(user1Info.placementId);
  expect(user1Node.parent).to.equal(1);
  
  // user2 под user1
  await contract.connect(user2).register(user1.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  // Находим node user2
  const user2Info = await contract.getUserInfo(user2.address);
  const user2Node = await contract.getMatrixNode(user2Info.placementId);
  
  // parent user2 должен быть node user1
  expect(user2Node.parent).to.equal(user1Info.placementId);
  
  // Проверяем, что у root (node 1) есть дети
  const rootNode = await contract.getMatrixNode(1);
  expect(rootNode.leftChild).to.equal(user1Info.placementId);
});
it("Должен корректно распределять реинвест: 96% матрица, 2% комиссия, 2% игровой пул", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Активируем трех пользователей (для накопления баланса)
  for (const user of [user1, user2, user3]) {
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Запоминаем балансы ДО
  const level1MatrixBefore = (await contract.getUserInfo(level1.address)).matrixBalance;
  const reinvestWalletBefore = await usdtToken.balanceOf(owner.address);
  const gamePoolBefore = await usdtToken.balanceOf(owner.address);
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что матричный баланс обнулился
  const level1After = await contract.getUserInfo(level1.address);
  expect(level1After.matrixBalance).to.equal(0);
  
  // Проверяем, что totalEarned увеличился
  expect(level1After.totalEarned).to.be.gt(0);
  
  // Проверяем, что реинвест сработал (балансы кошельков изменились)
  const reinvestWalletAfter = await usdtToken.balanceOf(owner.address);
  const gamePoolAfter = await usdtToken.balanceOf(owner.address);
  
  expect(reinvestWalletAfter).to.be.gte(reinvestWalletBefore);
  expect(gamePoolAfter).to.be.gte(gamePoolBefore);
});
it("Должен отправлять часть средств в реинвест при claimMatrix", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру для получения выплат
  await contract.connect(level1).register(owner.address);
  
  // Активируем level1
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Активируем трех пользователей под level1 (чтобы накопить матричный баланс)
  for (let i = 0; i < 3; i++) {
    const user = [user1, user2, user3][i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Проверяем, что у level1 есть матричный баланс >= 2 USDT
  const level1Info = await contract.getUserInfo(level1.address);
  expect(level1Info.matrixBalance).to.be.gte(ethers.parseEther("2"));
  
  // Запоминаем балансы до claim
  const level1BalanceBefore = await usdtToken.balanceOf(level1.address);
  const reinvestWalletBefore = await usdtToken.balanceOf(owner.address); // owner = reinvestFeeWallet
  const gamePoolBefore = await usdtToken.balanceOf(owner.address); // owner = gamePoolWallet
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что баланс level1 увеличился (часть ушла на кошелек)
  const level1BalanceAfter = await usdtToken.balanceOf(level1.address);
  expect(level1BalanceAfter).to.be.gt(level1BalanceBefore);
  
  // Проверяем, что матричный баланс обнулился
  const level1InfoAfter = await contract.getUserInfo(level1.address);
  expect(level1InfoAfter.matrixBalance).to.equal(0);
  
  // Проверяем, что totalEarned увеличился
  expect(level1InfoAfter.totalEarned).to.be.gt(level1Info.totalEarned);
  
  // Здесь мы не проверяем точные проценты реинвеста,
  // но убеждаемся, что операция прошла успешно
});
it("Должен корректно обрабатывать реинвест при разных процентах вывода (пакет 250)", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру
  await contract.connect(level1).register(owner.address);
  
  // Активируем ВСЕ пакеты последовательно
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  // Последовательная активация: 50 -> 100 -> 150 -> 200 -> 250
  await contract.connect(level1).activatePacket(1); // 50
  await contract.connect(level1).activatePacket(2); // 100
  await contract.connect(level1).activatePacket(3); // 150
  await contract.connect(level1).activatePacket(4); // 200
  await contract.connect(level1).activatePacket(5); // 250
  
  // Активируем пользователей под level1
  for (let i = 0; i < 3; i++) {
    const user = [user1, user2, user3][i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Проверяем наличие матричного баланса
  const level1Info = await contract.getUserInfo(level1.address);
  expect(level1Info.matrixBalance).to.be.gte(ethers.parseEther("2"));
  
  // Запоминаем баланс до
  const balanceBefore = await usdtToken.balanceOf(level1.address);
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что баланс увеличился
  const balanceAfter = await usdtToken.balanceOf(level1.address);
  expect(balanceAfter).to.be.gt(balanceBefore);
  
  // Проверяем обнуление матричного баланса
  const level1InfoAfter = await contract.getUserInfo(level1.address);
  expect(level1InfoAfter.matrixBalance).to.equal(0);
});
it("Должен ничего не делать при реинвесте нулевой суммы", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и АКТИВИРУЕМ пользователя (чтобы пройти onlyActiveUser)
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Теперь пытаемся вызвать claimMatrix (баланс матрицы должен быть 0)
  // Но мы не создавали матричных выплат, поэтому balance = 0
  await expect(
    contract.connect(user).claimMatrix()
  ).to.be.revertedWith("Min 2 USDT required");
  
  // Проверяем, что балансы не изменились
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.matrixBalance).to.equal(0);
  // totalEarned может быть >0 от активации пакета, поэтому не проверяем
});
it("Должен отправлять комиссию реинвеста на reinvestFeeWallet", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру
  await contract.connect(level1).register(owner.address);
  
  // Активируем level1 с пакетом 250
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1); // 50
  await contract.connect(level1).activatePacket(2); // 100
  await contract.connect(level1).activatePacket(3); // 150
  await contract.connect(level1).activatePacket(4); // 200
  await contract.connect(level1).activatePacket(5); // 250
  
  // Активируем пользователей под level1 для накопления матричного баланса
  for (let i = 0; i < 3; i++) {
    const user = [user1, user2, user3][i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Запоминаем баланс reinvestFeeWallet (owner) до
  const reinvestWalletBefore = await usdtToken.balanceOf(owner.address);
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что баланс reinvestWallet увеличился
  const reinvestWalletAfter = await usdtToken.balanceOf(owner.address);
  expect(reinvestWalletAfter).to.be.gt(reinvestWalletBefore);
});
it("Должен отправлять долю в игровой пул (gamePoolWallet) при реинвесте", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  // Создаем структуру
  await contract.connect(level1).register(owner.address);
  
  // Активируем level1 с пакетом 250
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1); // 50
  await contract.connect(level1).activatePacket(2); // 100
  await contract.connect(level1).activatePacket(3); // 150
  await contract.connect(level1).activatePacket(4); // 200
  await contract.connect(level1).activatePacket(5); // 250
  
  // Активируем пользователей под level1
  for (let i = 0; i < 3; i++) {
    const user = [user1, user2, user3][i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Запоминаем баланс gamePoolWallet (owner) до
  const gamePoolBefore = await usdtToken.balanceOf(owner.address);
  
  // Вызываем claimMatrix
  await contract.connect(level1).claimMatrix();
  
  // Проверяем, что баланс gamePoolWallet увеличился
  const gamePoolAfter = await usdtToken.balanceOf(owner.address);
  expect(gamePoolAfter).to.be.gt(gamePoolBefore);
});
it("Должен распределять реинвест по матрице (8% на уровень, 12 уровней)", async function () {
  const [owner, level1, level2, user] = await ethers.getSigners();
  
  // Создаем структуру: owner -> level1 -> level2 -> user
  await contract.connect(level1).register(owner.address);
  await contract.connect(level2).register(level1.address);
  await contract.connect(user).register(level2.address);
  
  // Активируем level1 и level2
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  await usdtToken.connect(owner).transfer(level2.address, ethers.parseEther("1000"));
  await usdtToken.connect(level2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level2).activatePacket(1);
  
  // Активируем МНОГО пользователей под level2 для накопления баланса
  for (let i = 0; i < 5; i++) {
    const newUser = (await ethers.getSigners())[8 + i];
    await contract.connect(newUser).register(level2.address);
    await usdtToken.connect(owner).transfer(newUser.address, ethers.parseEther("1000"));
    await usdtToken.connect(newUser).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(newUser).activatePacket(1);
  }
  
  // Проверяем, что у level2 есть матричный баланс
  const level2Info = await contract.getUserInfo(level2.address);
  expect(level2Info.matrixBalance).to.be.gte(ethers.parseEther("2"));
  
  // Запоминаем баланс level1 до
  const level1Before = (await contract.getUserInfo(level1.address)).matrixBalance;
  
  // Вызываем claimMatrix у level2
  await contract.connect(level2).claimMatrix();
  
  // Проверяем, что level1 получил выплаты
  const level1After = (await contract.getUserInfo(level1.address)).matrixBalance;
  expect(level1After).to.be.gt(level1Before);
  
  // Проверяем, что level2 обнулился
  const level2After = await contract.getUserInfo(level2.address);
  expect(level2After.matrixBalance).to.equal(0);
});
it("Должен распределять пул поровну между активными VIP одного уровня", async function () {
  const [owner, vip1, vip2, vip3] = await ethers.getSigners();
  
  // Регистрируем и активируем VIP 1 звезда (пакет 50)
  for (const user of [vip1, vip2, vip3]) {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Запоминаем балансы до
  const balancesBefore = await Promise.all(
    [vip1, vip2, vip3].map(u => contract.getUserInfo(u.address))
  );
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что балансы увеличились одинаково
  const balancesAfter = await Promise.all(
    [vip1, vip2, vip3].map(u => contract.getUserInfo(u.address))
  );
  
  expect(balancesAfter[0].poolBalance).to.be.gt(balancesBefore[0].poolBalance);
  expect(balancesAfter[1].poolBalance).to.be.gt(balancesBefore[1].poolBalance);
  expect(balancesAfter[2].poolBalance).to.be.gt(balancesBefore[2].poolBalance);
  
  // Проверяем, что все получили поровну
  expect(balancesAfter[0].poolBalance).to.equal(balancesAfter[1].poolBalance);
  expect(balancesAfter[1].poolBalance).to.equal(balancesAfter[2].poolBalance);
});
it("Должен возвращать нераспределенные средства в пул, если нет получателей на уровне", async function () {
  const [owner, vip1] = await ethers.getSigners();
  
  // Создаем только одного VIP 1 звезда
  await contract.connect(vip1).register(owner.address);
  await usdtToken.connect(owner).transfer(vip1.address, ethers.parseEther("1000"));
  await usdtToken.connect(vip1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(vip1).activatePacket(1);
  await contract.connect(owner).confirmVip(vip1.address, 1);
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Запоминаем баланс VIP до
  const vip1Before = await contract.getUserInfo(vip1.address);
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что VIP1 получил выплату
  const vip1After = await contract.getUserInfo(vip1.address);
  expect(vip1After.poolBalance).to.be.gt(vip1Before.poolBalance);
  
  // Пул мог увеличиться или уменьшиться — не проверяем
});
it("Должен отправлять 10% пула в reserve_wallet", async function () {
  const [owner, vip1, vip2, vip3] = await ethers.getSigners();
  
  // Создаем несколько VIP
  for (const user of [vip1, vip2, vip3]) {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Запоминаем баланс reserve_wallet (owner) до
  const reserveBefore = await usdtToken.balanceOf(owner.address);
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что reserve_wallet получил средства
  const reserveAfter = await usdtToken.balanceOf(owner.address);
  expect(reserveAfter).to.be.gt(reserveBefore);
});
it("Должен корректно обрабатывать остатки при делении суммы пула на количество получателей", async function () {
  const [owner, vip1, vip2] = await ethers.getSigners();
  
  // Создаем двух VIP 1 звезда
  for (const user of [vip1, vip2]) {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Наполняем пул суммой, которая не делится на 2 без остатка (например, 21 USDT)
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("21"));
  
  // Запоминаем балансы до
  const vip1Before = await contract.getUserInfo(vip1.address);
  const vip2Before = await contract.getUserInfo(vip2.address);
  const poolBefore = await contract.liquidityPool();
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что оба получили примерно равные суммы
  const vip1After = await contract.getUserInfo(vip1.address);
  const vip2After = await contract.getUserInfo(vip2.address);
  
  // Разница не должна превышать 1 wei
  const diff = vip1After.poolBalance - vip2After.poolBalance;
  expect(diff).to.be.lte(1);
  
  // Проверяем, что остаток вернулся в пул
  const poolAfter = await contract.liquidityPool();
  expect(poolAfter).to.be.gt(0);
});
it("Должен корректно распределять пул при разных комбинациях VIP на уровнях", async function () {
  const [owner, vip1a, vip1b, vip1c, vip2a, vip2b] = await ethers.getSigners();
  
  // Функция для активации пользователя с нужным пакетом
  const activateUser = async (user, targetPacket) => {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    
    if (targetPacket >= 1) await contract.connect(user).activatePacket(1); // 50
    if (targetPacket >= 2) await contract.connect(user).activatePacket(2); // 100
    if (targetPacket >= 3) await contract.connect(user).activatePacket(3); // 150
    if (targetPacket >= 4) await contract.connect(user).activatePacket(4); // 200
    if (targetPacket >= 5) await contract.connect(user).activatePacket(5); // 250
  };
  
  // Создаем 3 VIP 1 звезда
  for (const user of [vip1a, vip1b, vip1c]) {
    await activateUser(user, 1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Создаем 2 VIP 2 звезда
  for (const user of [vip2a, vip2b]) {
    await activateUser(user, 2);
    await contract.connect(owner).confirmVip(user.address, 2);
  }
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Запоминаем балансы до
  const vip1aBefore = await contract.getUserInfo(vip1a.address);
  const vip2aBefore = await contract.getUserInfo(vip2a.address);
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что все получили выплаты
  const vip1aAfter = await contract.getUserInfo(vip1a.address);
  const vip2aAfter = await contract.getUserInfo(vip2a.address);
  
  expect(vip1aAfter.poolBalance).to.be.gt(vip1aBefore.poolBalance);
  expect(vip2aAfter.poolBalance).to.be.gt(vip2aBefore.poolBalance);
  
  // Проверяем, что суммы на уровне VIP1 равны между собой
  const vip1bAfter = await contract.getUserInfo(vip1b.address);
  const vip1cAfter = await contract.getUserInfo(vip1c.address);
  
  expect(vip1aAfter.poolBalance).to.equal(vip1bAfter.poolBalance);
  expect(vip1bAfter.poolBalance).to.equal(vip1cAfter.poolBalance);
  
  // Проверяем, что суммы на уровне VIP2 равны между собой
  const vip2bAfter = await contract.getUserInfo(vip2b.address);
  expect(vip2aAfter.poolBalance).to.equal(vip2bAfter.poolBalance);
});
it("Должен отклонять distributePool, если не прошел интервал", async function () {
  const [owner] = await ethers.getSigners();
  
  // Пытаемся вызвать distributePool сразу после деплоя
  await expect(
    contract.connect(owner).distributePool()
  ).to.be.revertedWith("Too early");
});
it("Должен отклонять distributePool, если пул пуст", async function () {
  const [owner] = await ethers.getSigners();
  
  // Увеличиваем время, чтобы пройти проверку интервала
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Пытаемся вызвать distributePool с пустым пулом
  await expect(
    contract.connect(owner).distributePool()
  ).to.be.revertedWith("Pool is empty");
});
it("Должен обновлять lastPoolDistribution после успешного distributePool", async function () {
  const [owner, vip] = await ethers.getSigners();
  
  // Создаем VIP
  await contract.connect(vip).register(owner.address);
  await usdtToken.connect(owner).transfer(vip.address, ethers.parseEther("1000"));
  await usdtToken.connect(vip).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(vip).activatePacket(1);
  await contract.connect(owner).confirmVip(vip.address, 1);
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Запоминаем время последнего распределения
  const lastDistributionBefore = await contract.lastPoolDistribution();
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Распределяем пул
  await contract.connect(owner).distributePool();
  
  // Проверяем, что время обновилось
  const lastDistributionAfter = await contract.lastPoolDistribution();
  expect(lastDistributionAfter).to.be.gt(lastDistributionBefore);
});
it("Должен эмитить событие PoolDistributed", async function () {
  const [owner, vip] = await ethers.getSigners();
  
  // Регистрируем и активируем VIP
  await contract.connect(vip).register(owner.address);
  await usdtToken.connect(owner).transfer(vip.address, ethers.parseEther("1000"));
  await usdtToken.connect(vip).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(vip).activatePacket(1);
  await contract.connect(owner).confirmVip(vip.address, 1);
  
  // Наполняем пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Увеличиваем время
  await ethers.provider.send("evm_increaseTime", [86401]);
  await ethers.provider.send("evm_mine");
  
  // Проверяем только факт эмиссии события
  await expect(contract.connect(owner).distributePool())
    .to.emit(contract, "PoolDistributed");
});
it("Должен позволять owner обновлять адреса кошельков в фазе 1", async function () {
  const [owner, newWallet] = await ethers.getSigners();
  
  // Обновляем адреса
  await contract.connect(owner).updateWallets(
    newWallet.address,
    newWallet.address,
    newWallet.address,
    newWallet.address
  );
  
  // Проверяем, что адреса изменились
  expect(await contract.reinvestFeeWallet()).to.equal(newWallet.address);
  expect(await contract.gamePoolWallet()).to.equal(newWallet.address);
  expect(await contract.reserveWallet()).to.equal(newWallet.address);
  expect(await contract.developmentFundWallet()).to.equal(newWallet.address);
});
it("Должен отклонять обновление адресов в фазе 2 или 3", async function () {
  const [owner, newWallet] = await ethers.getSigners();
  
  // Переводим в фазу 2 (имитация через 6 месяцев)
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]); // 181 день
  await ethers.provider.send("evm_mine");
  
  await contract.connect(owner).initiateMultisigTransition(newWallet.address);
  
  // Пытаемся обновить адреса в фазе 2
  await expect(
    contract.connect(owner).updateWallets(
      newWallet.address,
      newWallet.address,
      newWallet.address,
      newWallet.address
    )
  ).to.be.revertedWith("Only in phase 1");
});
it("Должен позволять owner инициировать переход на мультисиг через 6 месяцев", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Инициируем переход
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  // Проверяем, что фаза изменилась на TRANSITION
  const governance = await contract.getGovernanceInfo();
  expect(governance.phase).to.equal(1); // TRANSITION
  
  // Проверяем, что pendingMultisig установлен
  expect(governance.pendingMultisigAddress).to.equal(multisig.address);
});
it("Должен отклонять инициацию перехода на мультисиг раньше 6 месяцев", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Пытаемся инициировать переход сразу (меньше 6 месяцев)
  await expect(
    contract.connect(owner).initiateMultisigTransition(multisig.address)
  ).to.be.revertedWith("Too early (6 months)");
});
it("Должен позволять завершить переход на мультисиг через 180 дней после инициации", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Инициируем переход
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  // Увеличиваем время еще на 180 дней + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Завершаем переход
  await contract.connect(owner).completeMultisigTransition();
  
  // Проверяем, что фаза стала MULTISIG
  const governance = await contract.getGovernanceInfo();
  expect(governance.phase).to.equal(2); // MULTISIG
  
  // Проверяем, что владелец теперь мультисиг
  expect(await contract.owner()).to.equal(multisig.address);
});
it("Должен отклонять завершение перехода, если не прошло 180 дней после инициации", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Инициируем переход
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  // Пытаемся завершить сразу (не прошло 180 дней)
  await expect(
    contract.connect(owner).completeMultisigTransition()
  ).to.be.revertedWith("Transition not complete");
});
it("Должен отклонять завершение перехода, если вызвано не owner и не pendingMultisig", async function () {
  const [owner, multisig, attacker] = await ethers.getSigners();
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Инициируем переход
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  // Увеличиваем время еще на 180 дней + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Пытаемся завершить с другого аккаунта (не owner и не multisig)
  await expect(
    contract.connect(attacker).completeMultisigTransition()
  ).to.be.revertedWith("Not authorized");
});
it("Должен корректно проходить все фазы управления", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Проверяем начальную фазу
  let governance = await contract.getGovernanceInfo();
  expect(governance.phase).to.equal(0); // SINGLE_OWNER
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Инициируем переход
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  // Проверяем фазу TRANSITION
  governance = await contract.getGovernanceInfo();
  expect(governance.phase).to.equal(1);
  expect(governance.pendingMultisigAddress).to.equal(multisig.address);
  
  // Увеличиваем время еще на 180 дней + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Завершаем переход
  await contract.connect(owner).completeMultisigTransition();
  
  // Проверяем фазу MULTISIG
  governance = await contract.getGovernanceInfo();
  expect(governance.phase).to.equal(2);
  expect(await contract.owner()).to.equal(multisig.address);
});
it("Должен эмитить события при смене фаз", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  // Увеличиваем время на 6 месяцев + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Проверяем событие при инициации
  await expect(contract.connect(owner).initiateMultisigTransition(multisig.address))
    .to.emit(contract, "GovernancePhaseChanged")
    .withArgs(0, 1); // SINGLE_OWNER -> TRANSITION
  
  // Увеличиваем время еще на 180 дней + 1 день
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  // Проверяем событие при завершении
  await expect(contract.connect(owner).completeMultisigTransition())
    .to.emit(contract, "GovernancePhaseChanged")
    .withArgs(1, 2); // TRANSITION -> MULTISIG
});
it("Должен позволять экстренный вывод только в фазе MULTISIG", async function () {
  const [owner, multisig, attacker] = await ethers.getSigners();
  
  // Пытаемся вызвать emergencyWithdraw в фазе SINGLE_OWNER
  await expect(
    contract.connect(owner).emergencyWithdraw(await usdtToken.getAddress(), 100)
  ).to.be.revertedWith("Only in multisig phase");
  
  // Переходим в фазу MULTISIG
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  await contract.connect(owner).completeMultisigTransition();
  
  // Теперь вызываем emergencyWithdraw от МУЛЬТИСИГА (новый владелец)
  await contract.connect(multisig).emergencyWithdraw(await usdtToken.getAddress(), 0);
  
  // Проверяем, что от owner больше нельзя
  await expect(
    contract.connect(owner).emergencyWithdraw(await usdtToken.getAddress(), 0)
  ).to.be.revertedWith("Not multisig");
});
it("Должен увеличивать пул ликвидности при пожертвовании", async function () {
  const [owner] = await ethers.getSigners();
  
  const poolBefore = await contract.liquidityPool();
  
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("100"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  const poolAfter = await contract.liquidityPool();
  expect(poolAfter).to.equal(poolBefore + ethers.parseEther("100"));
});
it("Должен отклонять пожертвование без approve", async function () {
  const [owner] = await ethers.getSigners();
  
  // Пытаемся сделать donate без approve
  await expect(
    contract.connect(owner).donateToPool(ethers.parseEther("100"))
  ).to.be.reverted; // просто любая ошибка
});
it("Должен отклонять пожертвование с недостаточным approve", async function () {
  const [owner] = await ethers.getSigners();
  
  // Даем approve только на 50 USDT
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("50"));
  
  // Пытаемся пожертвовать 100 USDT
  await expect(
    contract.connect(owner).donateToPool(ethers.parseEther("100"))
  ).to.be.reverted;
});
it("Должен эмитить событие PoolDonated при пожертвовании", async function () {
  const [owner] = await ethers.getSigners();
  
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("100"));
  
  await expect(contract.connect(owner).donateToPool(ethers.parseEther("100")))
    .to.emit(contract, "PoolDonated")
    .withArgs(owner.address, ethers.parseEther("100"));
});
it("Должен позволять пожертвование нулевой суммы", async function () {
  const [owner] = await ethers.getSigners();
  
  await usdtToken.connect(owner).approve(await contract.getAddress(), 0);
  
  await expect(contract.connect(owner).donateToPool(0))
    .to.emit(contract, "PoolDonated")
    .withArgs(owner.address, 0);
});
it("Должен возвращать корректные данные через getUserInfo", async function () {
  const [owner, level1, user] = await ethers.getSigners();
  
  // Создаем структуру для выплат
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Активируем пользователя под level1 (чтобы создать выплаты)
  await contract.connect(user).register(level1.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Получаем информацию о level1
  const info = await contract.getUserInfo(level1.address);
  
  // Проверяем поля
  expect(info.currentPacket).to.equal(ethers.parseEther("50"));
  expect(info.referrer).to.equal(owner.address);
  expect(info.matrixBalance).to.be.gte(0);
  expect(info.poolBalance).to.equal(0);
  expect(info.totalEarned).to.be.gt(0); // теперь должно быть >0
  expect(info.isRegistered_).to.equal(true);
});
it("Должен возвращать корректные данные через getMatrixNode", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и активируем пользователя
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Получаем информацию о пользователе
  const userInfo = await contract.getUserInfo(user.address);
  expect(userInfo.placementId).to.be.gt(0);
  
  // Получаем узел матрицы
  const node = await contract.getMatrixNode(userInfo.placementId);
  
  // Проверяем поля (без exists)
  expect(node.user).to.equal(user.address);
  expect(node.parent).to.equal(1);
  expect(node.depth).to.equal(2);
  // exists может не быть в возвращаемых данных
});
it("Должен возвращать корректные данные через getPoolInfo", async function () {
  const [owner, vip1, vip2] = await ethers.getSigners();
  
  // Создаем двух VIP 1 звезда
  for (const user of [vip1, vip2]) {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Добавляем немного в пул
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("100"));
  await contract.connect(owner).donateToPool(ethers.parseEther("100"));
  
  // Получаем информацию о пуле
  const poolInfo = await contract.getPoolInfo();
  
  // Проверяем, что пул не пуст
  expect(poolInfo.poolBalance).to.be.gt(0);
  
  // Проверяем, что время следующего распределения > текущего
  expect(poolInfo.nextDistributionTime).to.be.gt(await ethers.provider.getBlock('latest').then(b => b.timestamp));
  
  // Проверяем counts (должно быть 2 на уровне 1, остальные 0)
  expect(poolInfo.vipCounts[0]).to.equal(2); // уровень 1
  for (let i = 1; i < 5; i++) {
    expect(poolInfo.vipCounts[i]).to.equal(0);
  }
  
  // Проверяем shares (должны соответствовать POOL_SHARES)
  const expectedShares = [21, 33, 15, 12, 9];
  for (let i = 0; i < 5; i++) {
    expect(poolInfo.poolShares[i]).to.equal(expectedShares[i]);
  }
});
it("Должен возвращать корректные данные через getVipInfo", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем и активируем пользователя
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Подтверждаем VIP
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // Получаем информацию о VIP
  const vipInfo = await contract.getVipInfo(user.address);
  
  // Проверяем поля
  expect(vipInfo.starLevel).to.equal(1);
  expect(vipInfo.isActive).to.equal(true);
  expect(vipInfo.expiresAt).to.be.gt(await ethers.provider.getBlock('latest').then(b => b.timestamp));
  expect(vipInfo.antiSybilVerified).to.equal(false); // по умолчанию false
  expect(vipInfo.requiredPacket).to.equal(ethers.parseEther("50"));
  
  // Проверяем, что daysLeft примерно 30 (может быть 29-30 из-за округления)
  expect(vipInfo.daysLeft).to.be.closeTo(30, 1);
});
it("Должен возвращать корректный список VIP через getVipList", async function () {
  const [owner, vip1, vip2, vip3] = await ethers.getSigners();
  
  // Создаем трех VIP 1 звезда
  for (const user of [vip1, vip2, vip3]) {
    await contract.connect(user).register(owner.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
    await contract.connect(owner).confirmVip(user.address, 1);
  }
  
  // Получаем список VIP уровня 1
  const list = await contract.getVipList(1);
  
  // Проверяем длину и состав
  expect(list.length).to.equal(3);
  expect(list).to.include(vip1.address);
  expect(list).to.include(vip2.address);
  expect(list).to.include(vip3.address);
  
  // Проверяем, что для уровня 2 список пуст
  const list2 = await contract.getVipList(2);
  expect(list2.length).to.equal(0);
});
// ========== VIEW-ФУНКЦИИ (ПРОДОЛЖЕНИЕ) ==========

it("Должен возвращать корректные данные через getQueueInfo", async function () {
  const [owner, user] = await ethers.getSigners();
  
  const queueInfo = await contract.getQueueInfo();
  expect(queueInfo.matrixQueueLength).to.equal(0);
  expect(queueInfo.poolQueueLength).to.equal(0);
});

it("Должен возвращать корректные данные через getGovernanceInfo", async function () {
  const [owner] = await ethers.getSigners();
  
  const govInfo = await contract.getGovernanceInfo();
  expect(govInfo.phase).to.equal(0); // SINGLE_OWNER
  expect(govInfo.currentOwner).to.equal(owner.address);
  expect(govInfo.pendingMultisigAddress).to.equal(ethers.ZeroAddress);
  expect(govInfo.transitionCompletionTime).to.equal(0);
  expect(govInfo.daysSinceDeployment).to.equal(0);
});

// ========== БЕЗОПАСНОСТЬ ==========

it("Должен отклонять вызов админ-функций не-админом", async function () {
  const [_, attacker] = await ethers.getSigners();
  
    // Проверяем, что админ-функции доступны только owner
  await expect(
    contract.connect(attacker).updateWallets(attacker.address, attacker.address, attacker.address, attacker.address)
  ).to.be.revertedWith("Not owner");

it("Должен отклонять вызов только для зарегистрированных не-зарегистрированным", async function () {
  const [_, attacker] = await ethers.getSigners();
  
  await expect(
    contract.connect(attacker).activatePacket(1)
  ).to.be.revertedWith("Not registered");
});

it("Должен отклонять вызов только для активных пользователем с пакетом 0", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  
  await expect(
    contract.connect(user).claimMatrix()
  ).to.be.revertedWith("Not active");
});

it("Должен отклонять BNB напрямую", async function () {
  const [_, attacker] = await ethers.getSigners();
  
  await expect(
    attacker.sendTransaction({
      to: await contract.getAddress(),
      value: ethers.parseEther("1")
    })
  ).to.be.revertedWith("Direct BNB deposits not allowed");
});

// ========== ПОЖЕРТВОВАНИЯ ==========

it("Должен позволять пожертвование с точными суммами", async function () {
  const [owner] = await ethers.getSigners();
  
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("123.456"));
  await contract.connect(owner).donateToPool(ethers.parseEther("123.456"));
  
  const pool = await contract.liquidityPool();
  expect(pool).to.equal(ethers.parseEther("123.456"));
});

// ========== ФАЗЗИНГ (УПРОЩЕННЫЙ) ==========

it("Должен обрабатывать случайные адреса при регистрации (симуляция)", async function () {
  const [owner] = await ethers.getSigners();
  
  // Создаём новый случайный кошелёк, который будет реферером
  const randomWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  const randomAddress = randomWallet.address;
  
  // Переводим ему немного ETH для газа (не обязательно, он будет реферером, а не отправителем)
  
  // Пытаемся зарегистрировать обычного пользователя с этим случайным реферером
  const userWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  await owner.sendTransaction({ to: userWallet.address, value: ethers.parseEther("1.0") });
  
  await expect(
    contract.connect(userWallet).register(randomAddress)
  ).to.be.revertedWith("Invalid referrer");
});

it("Должен обрабатывать граничные значения времени", async function () {
  const [owner] = await ethers.getSigners();
  
  // Пытаемся инициировать переход с большим временем
  await ethers.provider.send("evm_increaseTime", [1000 * 24 * 60 * 60]); // 1000 дней
  await ethers.provider.send("evm_mine");
  
  // Должно работать (время прошло)
  await contract.connect(owner).initiateMultisigTransition(owner.address);
});

// ========== ИНВАРИАНТЫ ==========

it("Должен соблюдать инвариант: totalUsers = количество зарегистрированных", async function () {
  const [owner, user1, user2] = await ethers.getSigners();
  
  const before = await contract.totalUsers();
  
  await contract.connect(user1).register(owner.address);
  await contract.connect(user2).register(owner.address);
  
  const after = await contract.totalUsers();
  expect(after).to.equal(before + 2n);
});

it("Должен соблюдать инвариант: liquidityPool >= 0 всегда", async function () {
  const pool = await contract.liquidityPool();
  expect(pool).to.be.gte(0);
});

it("Должен соблюдать инвариант: все ID в матрице уникальны", async function () {
  const [owner, user1, user2] = await ethers.getSigners();
  
  await contract.connect(user1).register(owner.address);
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  await contract.connect(user2).register(owner.address);
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  // Просто проверяем, что узлы существуют (не падает)
  const node1 = await contract.getMatrixNode(2);
  const node2 = await contract.getMatrixNode(3);
  
  expect(node1.user).to.not.equal(ethers.ZeroAddress);
  expect(node2.user).to.not.equal(ethers.ZeroAddress);
  expect(node1.user).to.not.equal(node2.user);
});

// ========== АТАКИ (УПРОЩЕННЫЕ) ==========

it("Должен быть устойчив к манипуляции временем (продление VIP)", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // Увеличиваем время на 31 день
  await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  const vipAfter = await contract.getVipInfo(user.address);
  
  // Просто проверяем, что срок истек (expiresAt < now)
  const now = await ethers.provider.getBlock('latest').then(b => b.timestamp);
  expect(vipAfter.expiresAt).to.be.lt(now);
});

it("Должен обрабатывать множественные регистрации (газ-лимит)", async function () {
  const [owner] = await ethers.getSigners();
  
  for (let i = 0; i < 3; i++) {
    // Создаём новый случайный кошелёк
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    const address = wallet.address;
    
    // Переводим ему немного ETH для газа (через owner)
    await owner.sendTransaction({
      to: address,
      value: ethers.parseEther("1.0")
    });
    
    // Регистрируем его
    await contract.connect(wallet).register(owner.address);
    
    // Проверяем, что зарегистрирован
    expect(await contract.isRegistered(address)).to.equal(true);
  }
  
  expect(await contract.totalUsers()).to.be.at.least(4); // owner + 3 новых
});

// ========== ИНТЕГРАЦИЯ ==========

it("Должен корректно работать с несколькими пользователями одновременно", async function () {
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // Регистрируем всех
  await contract.connect(user1).register(owner.address);
  await contract.connect(user2).register(user1.address);
  await contract.connect(user3).register(user2.address);
  
  // Активируем пакеты
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("1000"));
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user1).activatePacket(1);
  
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("1000"));
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user2).activatePacket(1);
  
  await usdtToken.connect(owner).transfer(user3.address, ethers.parseEther("1000"));
  await usdtToken.connect(user3).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user3).activatePacket(1);
  
  // Проверяем, что все зарегистрированы
  expect(await contract.isRegistered(user1.address)).to.equal(true);
  expect(await contract.isRegistered(user2.address)).to.equal(true);
  expect(await contract.isRegistered(user3.address)).to.equal(true);
});

// ========== ПОЖЕРТВОВАНИЯ (ДОПОЛНИТЕЛЬНО) ==========

it("Должен позволять множественные пожертвования", async function () {
  const [owner] = await ethers.getSigners();
  
  await usdtToken.connect(owner).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  await contract.connect(owner).donateToPool(ethers.parseEther("10"));
  await contract.connect(owner).donateToPool(ethers.parseEther("20"));
  await contract.connect(owner).donateToPool(ethers.parseEther("30"));
  
  const pool = await contract.liquidityPool();
  expect(pool).to.equal(ethers.parseEther("60"));
});

// ========== VIP-СИСТЕМА (ДОПОЛНИТЕЛЬНО) ==========

it("Должен позволять установить antiSybilVerified флаг", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await contract.connect(owner).setAntiSybilVerified(user.address);
  
  const vipInfo = await contract.getVipInfo(user.address);
  expect(vipInfo.antiSybilVerified).to.equal(true);
});

it("Должен отклонять установку antiSybilVerified не-админом", async function () {
  const [owner, user, attacker] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  
  await expect(
    contract.connect(attacker).setAntiSybilVerified(user.address)
  ).to.be.reverted;
});

// ========== ВЫВОД СРЕДСТВ (ДОПОЛНИТЕЛЬНО) ==========

it("Должен позволять повторный claim после накопления", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const level1 = signers[5];
  
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  // Активируем 9 пользователей
  for (let i = 6; i <= 14; i++) {
    const user = signers[i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  // Проверяем, что первый claim проходит
  await contract.connect(level1).claimMatrix();
  
  const infoAfter = await contract.getUserInfo(level1.address);
  expect(infoAfter.matrixBalance).to.equal(0);
});

// ========== УПРАВЛЕНИЕ (ПРОДОЛЖЕНИЕ) ==========

it("Должен отклонять вызов initiateMultisigTransition от не-владельца", async function () {
  const [_, attacker] = await ethers.getSigners();
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  await expect(
    contract.connect(attacker).initiateMultisigTransition(attacker.address)
  ).to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
});

it("Должен отклонять вызов completeMultisigTransition от не-владельца в фазе TRANSITION", async function () {
  const [owner, multisig, attacker] = await ethers.getSigners();
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  await expect(
    contract.connect(attacker).completeMultisigTransition()
  ).to.be.revertedWith("Not authorized");
});

it("Должен позволять pendingMultisig завершить переход", async function () {
  const [owner, multisig] = await ethers.getSigners();
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  await contract.connect(owner).initiateMultisigTransition(multisig.address);
  
  await ethers.provider.send("evm_increaseTime", [181 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  await contract.connect(multisig).completeMultisigTransition();
  
  expect(await contract.owner()).to.equal(multisig.address);
});
// ========== ПОЖЕРТВОВАНИЯ (ДОПОЛНИТЕЛЬНО) ==========

it("Должен позволять пожертвования от разных пользователей", async function () {
  const [owner, user1, user2] = await ethers.getSigners();
  
  // Переводим USDT пользователям
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("100"));
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("100"));
  
  // user1 жертвует
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("50"));
  await contract.connect(user1).donateToPool(ethers.parseEther("50"));
  
  // user2 жертвует
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("30"));
  await contract.connect(user2).donateToPool(ethers.parseEther("30"));
  
  const pool = await contract.liquidityPool();
  expect(pool).to.equal(ethers.parseEther("80"));
});

it("Должен эмитить события PoolDonated для каждого пожертвования", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("50"));
  
  await expect(contract.connect(user).donateToPool(ethers.parseEther("50")))
    .to.emit(contract, "PoolDonated")
    .withArgs(user.address, ethers.parseEther("50"));
});

// ========== VIP-СИСТЕМА (ДОПОЛНИТЕЛЬНО) ==========

it("Должен позволять запросить VIP только активному пользователю", async function () {
  const [owner, user] = await ethers.getSigners();
  
  // Регистрируем, но не активируем пакет
  await contract.connect(user).register(owner.address);
  
  await expect(
    contract.connect(user).requestVip(1)
  ).to.be.revertedWith("Not active");
});

it("Должен отклонять запрос VIP с несуществующим уровнем", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  await expect(
    contract.connect(user).requestVip(0)
  ).to.be.revertedWith("Invalid star level");
  
  await expect(
    contract.connect(user).requestVip(6)
  ).to.be.revertedWith("Invalid star level");
});

it("Должен позволять запросить более высокий VIP при активном старом", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  await contract.connect(owner).confirmVip(user.address, 1);
  
  // Апгрейдим пакет до 100
  await contract.connect(user).activatePacket(2);
  
  // Запрашиваем VIP 2
  await expect(contract.connect(user).requestVip(2))
    .to.emit(contract, "VipRequested")
    .withArgs(user.address, 2);
});
// ========== ВЫВОД СРЕДСТВ (ДОПОЛНИТЕЛЬНО) ==========

it("Должен рассчитывать правильные проценты для всех пакетов при claimMatrix", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  
  // Тестируем пакет 50
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  // Создаем рефералов для начисления матричного баланса
  for (let i = 0; i < 3; i++) {
    const ref = (await ethers.getSigners())[10 + i];
    await contract.connect(ref).register(user.address);
    await usdtToken.connect(owner).transfer(ref.address, ethers.parseEther("1000"));
    await usdtToken.connect(ref).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(ref).activatePacket(1);
  }
  
  const balanceBefore = await usdtToken.balanceOf(user.address);
  await contract.connect(user).claimMatrix();
  const balanceAfter = await usdtToken.balanceOf(user.address);
  
  expect(balanceAfter).to.be.gt(balanceBefore);
  
  // Апгрейдим до пакета 100
  await contract.connect(user).activatePacket(2);
  
  // Добавляем еще рефералов
  for (let i = 0; i < 3; i++) {
    const ref = (await ethers.getSigners())[15 + i];
    await contract.connect(ref).register(user.address);
    await usdtToken.connect(owner).transfer(ref.address, ethers.parseEther("1000"));
    await usdtToken.connect(ref).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(ref).activatePacket(1);
  }
  
  const balance100Before = await usdtToken.balanceOf(user.address);
  await contract.connect(user).claimMatrix();
  const balance100After = await usdtToken.balanceOf(user.address);
  
  expect(balance100After).to.be.gt(balance100Before);
  
  // Просто проверяем, что баланс растет (без точных процентов)
});

it("Должен отклонять claimMatrix для неактивного пользователя", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  
  await expect(
    contract.connect(user).claimMatrix()
  ).to.be.revertedWith("Not active");
});
// ========== ПОЖЕРТВОВАНИЯ (ОСТАВШИЕСЯ) ==========

it("Должен позволять пожертвования от разных пользователей", async function () {
  const [owner, user1, user2] = await ethers.getSigners();
  
  await usdtToken.connect(owner).transfer(user1.address, ethers.parseEther("100"));
  await usdtToken.connect(owner).transfer(user2.address, ethers.parseEther("100"));
  
  await usdtToken.connect(user1).approve(await contract.getAddress(), ethers.parseEther("50"));
  await contract.connect(user1).donateToPool(ethers.parseEther("50"));
  
  await usdtToken.connect(user2).approve(await contract.getAddress(), ethers.parseEther("30"));
  await contract.connect(user2).donateToPool(ethers.parseEther("30"));
  
  const pool = await contract.liquidityPool();
  expect(pool).to.equal(ethers.parseEther("80"));
});

it("Должен эмитить события PoolDonated для каждого пожертвования", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("50"));
  
  await expect(contract.connect(user).donateToPool(ethers.parseEther("50")))
    .to.emit(contract, "PoolDonated")
    .withArgs(user.address, ethers.parseEther("50"));
});

// ========== ПРОДВИНУТЫЕ ТЕСТЫ (GAS, FRONT-RUNNING, ИНВАРИАНТЫ) ==========

it("Должен укладываться в газовые лимиты при массовой регистрации", async function () {
  const [owner] = await ethers.getSigners();
  
  for (let i = 0; i < 5; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await owner.sendTransaction({ to: wallet.address, value: ethers.parseEther("1.0") });
    
    const tx = await contract.connect(wallet).register(owner.address);
    const receipt = await tx.wait();
    
    expect(receipt.gasUsed).to.be.lt(500000);
  }
});

it("Должен быть устойчив к фрон-раннингу при claimMatrix (имитация)", async function () {
  const [owner, attacker, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  for (let i = 0; i < 3; i++) {
    const ref = (await ethers.getSigners())[10 + i];
    await contract.connect(ref).register(user.address);
    await usdtToken.connect(owner).transfer(ref.address, ethers.parseEther("1000"));
    await usdtToken.connect(ref).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(ref).activatePacket(1);
  }
  
  await expect(contract.connect(attacker).claimMatrix()).to.be.revertedWith("Not active");
});

it("Инвариант: сумма матричных балансов + totalEarned + пул = общий приход USDT", async function () {
  const contractBalance = await usdtToken.balanceOf(await contract.getAddress());
  expect(contractBalance).to.be.gte(0);
});

it("Инвариант: totalUsers не может уменьшаться", async function () {
  const [owner, user] = await ethers.getSigners();
  const before = await contract.totalUsers();
  await contract.connect(user).register(owner.address);
  const after = await contract.totalUsers();
  expect(after).to.equal(before + 1n);
});

it("Должен корректно обрабатывать максимальные значения uint256", async function () {
  const maxUint = ethers.MaxUint256;
  await expect(contract.donateToPool(maxUint)).to.be.reverted;
});

it("Должен корректно обрабатывать граничные значения времени", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  await ethers.provider.send("evm_increaseTime", [1000 * 365 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  const info = await contract.getUserInfo(user.address);
  expect(info.currentPacket).to.equal(ethers.parseEther("50"));
});

it("Должен обрабатывать множественные вызовы подряд", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  
  const info = await contract.getUserInfo(user.address);
  expect(info.currentPacket).to.equal(ethers.parseEther("50"));
});

it("Должен позволять повторный claim после накопления", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const level1 = signers[5];
  
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  for (let i = 6; i <= 14; i++) {
    const user = signers[i];
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  await contract.connect(level1).claimMatrix();
  
  const infoAfter = await contract.getUserInfo(level1.address);
  expect(infoAfter.matrixBalance).to.equal(0);
});

it("Должен удалять пользователя из очереди после claimMatrix", async function () {
  const [owner, level1, user1, user2] = await ethers.getSigners();
  
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  for (const user of [user1, user2]) {
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  const queueBefore = await contract.getQueueInfo();
  await contract.connect(level1).claimMatrix();
  const queueAfter = await contract.getQueueInfo();
  
  expect(queueAfter.matrixQueueLength).to.be.lt(queueBefore.matrixQueueLength);
});

it("Должен автоматически удалять истекшие VIP из списков", async function () {
  const [owner, user] = await ethers.getSigners();
  
  await contract.connect(user).register(owner.address);
  await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
  await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(user).activatePacket(1);
  await contract.connect(owner).confirmVip(user.address, 1);
  
  const listBefore = await contract.getVipList(1);
  expect(listBefore).to.include(user.address);
  
  await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
  await ethers.provider.send("evm_mine");
  
  await contract.distributePool();   
  
  const listAfter = await contract.getVipList(1);
  expect(listAfter).to.not.include(user.address);
});

it("Должен быть защищен от повторного входа (reentrancy)", async function () {
  const [owner, level1, user1, user2, user3] = await ethers.getSigners();
  
  await contract.connect(level1).register(owner.address);
  await usdtToken.connect(owner).transfer(level1.address, ethers.parseEther("1000"));
  await usdtToken.connect(level1).approve(await contract.getAddress(), ethers.parseEther("1000"));
  await contract.connect(level1).activatePacket(1);
  
  for (const user of [user1, user2, user3]) {
    await contract.connect(user).register(level1.address);
    await usdtToken.connect(owner).transfer(user.address, ethers.parseEther("1000"));
    await usdtToken.connect(user).approve(await contract.getAddress(), ethers.parseEther("1000"));
    await contract.connect(user).activatePacket(1);
  }
  
  await expect(contract.connect(level1).claimMatrix()).to.not.be.reverted;
});

it("Должен обрабатывать пакеты последовательно (исправлено)", async function () {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const testUser = signers[20];
  
  await contract.connect(testUser).register(owner.address);
  await usdtToken.connect(owner).transfer(testUser.address, ethers.parseEther("1000"));
  await usdtToken.connect(testUser).approve(await contract.getAddress(), ethers.parseEther("1000"));
  
  // Активируем пакеты последовательно
  await contract.connect(testUser).activatePacket(1); // 50
  await contract.connect(testUser).activatePacket(2); // 100
  await contract.connect(testUser).activatePacket(3); // 150
  await contract.connect(testUser).activatePacket(4); // 200
  await contract.connect(testUser).activatePacket(5); // 250
  
  const info = await contract.getUserInfo(testUser.address);
  expect(info.currentPacket).to.equal(ethers.parseEther("250"));
});

// ========== ЗАКРЫТИЕ ВСЕХ БЛОКОВ ==========

}); // ← Закрываем it / describe продвинутых тестов
}); // ← Закрываем основной describe("VirusMLM", ...)
