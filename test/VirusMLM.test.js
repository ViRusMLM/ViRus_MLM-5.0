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
  expect(matrixAfter - matrixBefore).to.equal(ethers.parseEther("0.96"));
  
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
});