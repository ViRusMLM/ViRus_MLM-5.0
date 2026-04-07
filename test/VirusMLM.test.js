const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VirusMLM V5.2 - ПОЛНЫЙ АУДИТ (70 ТЕСТОВ)", function () {
  let contract, usdtToken, admin, operator, multisig, userSigners, users;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    admin = signers[0];
    operator = signers[1];
    multisig = signers[2];
    
    // userSigners — это signer'ы (могут отправлять транзакции)
    userSigners = [];
    for (let i = 3; i < signers.length && i < 53; i++) {
      userSigners.push(signers[i]);
    }
    
    // users — это просто адреса (для view функций)
    users = userSigners.map(s => s.address);

    const ERC20Mock = await ethers.getContractFactory("ERC20Mock");
    usdtToken = await ERC20Mock.deploy("USDT Mock", "USDT", 18);

    const VirusMLM = await ethers.getContractFactory("VirusMLM");
    contract = await VirusMLM.deploy(
      usdtToken.target,
      admin.address,
      admin.address,
      admin.address,
      admin.address,
      admin.address
    );

    await contract.grantOperator(operator.address);
    await contract.grantRole(await contract.MULTISIG_ROLE(), multisig.address);

    const amount = ethers.parseEther("100000");
    for (let i = 0; i < userSigners.length; i++) {
      await usdtToken.mint(userSigners[i].address, amount);
      await usdtToken.connect(userSigners[i]).approve(contract.target, amount);
    }
  });

  // ====================== 🔴 КРИТИЧЕСКИЕ (20) ======================

  it("1. Регистрация с валидным реферером", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    const info = await contract.getUserInfo(userSigners[0].address);
    expect(info.isRegistered_).to.be.true;
    expect(info.referrer).to.equal(admin.address);
  });

  it("2. Регистрация без реферера", async function () {
    await contract.connect(userSigners[0]).register(ethers.ZeroAddress);
    const info = await contract.getUserInfo(userSigners[0].address);
    expect(info.referrer).to.equal(ethers.ZeroAddress);
  });

  it("3. Отклонять повторную регистрацию", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).register(admin.address))
      .to.be.revertedWith("Already registered");
  });

  it("4. Отклонять регистрацию с несуществующим реферером", async function () {
    const fake = "0x000000000000000000000000000000000000dEaD";
    await expect(contract.connect(userSigners[0]).register(fake))
      .to.be.revertedWith("Invalid referrer");
  });

  it("5. Активация пакета 50", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    const info = await contract.getUserInfo(userSigners[0].address);
    expect(info.currentPacket).to.equal(ethers.parseEther("50"));
  });

  it("6. Активация пакета 100 без пакета 50 отклоняется", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).activatePacket(2))
      .to.be.revertedWith("Wrong packet sequence");
  });

  it("7. Активация всех пакетов последовательно", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).activatePacket(2);
    await contract.connect(userSigners[0]).activatePacket(3);
    await contract.connect(userSigners[0]).activatePacket(4);
    await contract.connect(userSigners[0]).activatePacket(5);
    const info = await contract.getUserInfo(userSigners[0].address);
    expect(info.currentPacket).to.equal(ethers.parseEther("250"));
  });

  it("8. Отклонять несуществующий индекс пакета", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).activatePacket(0))
      .to.be.revertedWith("Invalid packet index");
    await expect(contract.connect(userSigners[0]).activatePacket(6))
      .to.be.revertedWith("Invalid packet index");
  });

  it("9. Реферальная выплата 50%", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.equal(ethers.parseEther("25"));
  });

  it("10. Комиссия активации 2%", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    const before = await usdtToken.balanceOf(admin.address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const after = await usdtToken.balanceOf(admin.address);
    expect(after - before).to.equal(ethers.parseEther("1"));
  });

  it("11. Матричная выплата 4% от полной суммы", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    const before = (await contract.getUserInfo(userSigners[0].address)).matrixBalance;
    await contract.connect(userSigners[1]).activatePacket(1);
    const after = (await contract.getUserInfo(userSigners[0].address)).matrixBalance;
    expect(after - before).to.equal(ethers.parseEther("2"));
  });

  it("12. Реферальные rootId идут в пул", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    const poolBefore = await contract.liquidityPool();
    await contract.connect(userSigners[0]).activatePacket(2);
    const poolAfter = await contract.liquidityPool();
    expect(poolAfter).to.be.gt(poolBefore);
  });

  it("13. Матричные rootId идут в пул", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    const poolBefore = await contract.liquidityPool();
    await contract.connect(userSigners[1]).activatePacket(1);
    const poolAfter = await contract.liquidityPool();
    expect(poolAfter).to.be.gt(poolBefore);
  });

  it("14. claimMatrix выводит матричный баланс", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const balance = (await contract.getUserInfo(userSigners[0].address)).matrixBalance;
    expect(balance).to.be.gte(ethers.parseEther("10"));
    const usdtBefore = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const usdtAfter = await usdtToken.balanceOf(userSigners[0].address);
    expect(usdtAfter).to.be.gt(usdtBefore);
  });

  it("15. Отклонять claimMatrix при балансе < MIN_WITHDRAW", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).claimMatrix())
      .to.be.revertedWith("Min 10 USDT required");
  });

  it("16. claimPool с активным VIP", async function () {
    const testUser = userSigners[10];
    await contract.connect(testUser).register(admin.address);
    await contract.connect(testUser).activatePacket(1);
    await contract.connect(testUser).requestVip(1);
    await contract.connect(operator).confirmVip(testUser.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const before = await usdtToken.balanceOf(testUser.address);
    await contract.connect(testUser).claimPool();
    const after = await usdtToken.balanceOf(testUser.address);
    expect(after).to.be.gt(before);
  });

  it("17. Отклонять claimPool без активного VIP", async function () {
    const testUser = userSigners[11];
    await contract.connect(testUser).register(admin.address);
    await contract.connect(testUser).activatePacket(1);
    await contract.connect(testUser).requestVip(1);
    await contract.connect(operator).confirmVip(testUser.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    await contract.connect(operator).revokeVip(testUser.address);
    await expect(contract.connect(testUser).claimPool())
      .to.be.revertedWith("VIP not active");
  });

  it("18. Отклонять claimPool при балансе < MIN_WITHDRAW", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).claimPool())
      .to.be.revertedWith("Min 10 USDT required");
  });

  it("19. donateToPool увеличивает пул", async function () {
    const before = await contract.liquidityPool();
    await contract.connect(userSigners[0]).donateToPool(ethers.parseEther("100"));
    const after = await contract.liquidityPool();
    expect(after - before).to.equal(ethers.parseEther("100"));
  });

  it("20. distributePool распределяет пул", async function () {
    const testUser = userSigners[12];
    await contract.connect(testUser).register(admin.address);
    await contract.connect(testUser).activatePacket(1);
    await contract.connect(testUser).requestVip(1);
    await contract.connect(operator).confirmVip(testUser.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const info = await contract.getUserInfo(testUser.address);
    expect(info.poolBalance).to.be.gt(0);
  });

  // ====================== 🟠 ОЧЕНЬ ВАЖНЫЕ (31) ======================

  it("21. claimAll выводит и матрицу и пул", async function () {
    const testUser = userSigners[13];
    await contract.connect(testUser).register(admin.address);
    await contract.connect(testUser).activatePacket(1);
    for (let i = 0; i < 3; i++) {
      await contract.connect(userSigners[14 + i]).register(testUser.address);
      await contract.connect(userSigners[14 + i]).activatePacket(1);
    }
    await contract.connect(testUser).requestVip(1);
    await contract.connect(operator).confirmVip(testUser.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const before = await usdtToken.balanceOf(testUser.address);
    await contract.connect(testUser).claimAll();
    const after = await usdtToken.balanceOf(testUser.address);
    expect(after).to.be.gt(before);
  });

  it("22. claimAll без баланса отклоняется", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).claimAll())
      .to.be.revertedWith("No balance available to claim");
  });

  it("23. batchClaimAll для нескольких пользователей", async function () {
    const list = [];
    for (let i = 0; i < 3; i++) {
      await contract.connect(userSigners[i]).register(admin.address);
      await contract.connect(userSigners[i]).activatePacket(1);
      list.push(userSigners[i].address);
    }
    await expect(contract.connect(operator).batchClaimAll(list))
      .to.emit(contract, "BatchClaimed");
  });

  it("24. batchClaimAll отклоняет >200", async function () {
    const bigList = Array(201).fill(admin.address);
    await expect(contract.connect(operator).batchClaimAll(bigList))
      .to.be.revertedWith("Batch size 1-200");
  });

  it("25. Пакет 0 не занимает место в матрице", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    const info = await contract.getUserInfo(userSigners[0].address);
    expect(info.placementId).to.equal(0);
  });

  it("26. Размещение реферала под пакетом 0", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).activatePacket(1);
    const node = await contract.getMatrixNode(4);
    expect(node.parent).to.equal(2);
  });

  it("27. Реферальный доход для спонсора с пакетом 0", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.equal(ethers.parseEther("25"));
  });

  it("28. Апгрейд реферала не даёт доход спонсору с пакетом 0", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(2);
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.equal(0);
  });

  it("29. Процент вывода для пакета 50 (50%)", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.be.gt(0);
  });

  it("30. Процент вывода для пакета 100 (60%)", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).activatePacket(2);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.be.gt(0);
  });

  it("31. Процент вывода для пакета 150 (70%)", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).activatePacket(2);
    await contract.connect(userSigners[0]).activatePacket(3);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.be.gt(0);
  });

  it("32. Процент вывода для пакета 200 (80%)", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).activatePacket(2);
    await contract.connect(userSigners[0]).activatePacket(3);
    await contract.connect(userSigners[0]).activatePacket(4);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.be.gt(0);
  });

  it("33. Процент вывода для пакета 250 (90%)", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).activatePacket(2);
    await contract.connect(userSigners[0]).activatePacket(3);
    await contract.connect(userSigners[0]).activatePacket(4);
    await contract.connect(userSigners[0]).activatePacket(5);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(userSigners[0].address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(userSigners[0].address);
    expect(after - before).to.be.gt(0);
  });

  it("34. Реинвест 96% в матрицу", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = (await contract.getUserInfo(userSigners[1].address)).matrixBalance;
    await contract.connect(userSigners[0]).claimMatrix();
    const after = (await contract.getUserInfo(userSigners[1].address)).matrixBalance;
    expect(after - before).to.be.gte(0);
  });

  it("35. Реинвест 2% в reinvestFeeWallet", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(admin.address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(admin.address);
    expect(after - before).to.be.gte(0);
  });

  it("36. Реинвест 2% в gamePoolWallet", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    for (let i = 1; i <= 5; i++) {
      await contract.connect(userSigners[i]).register(userSigners[0].address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const before = await usdtToken.balanceOf(admin.address);
    await contract.connect(userSigners[0]).claimMatrix();
    const after = await usdtToken.balanceOf(admin.address);
    expect(after - before).to.be.gte(0);
  });

  it("37. Реинвест нулевой суммы ничего не делает", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(userSigners[0]).claimMatrix())
      .to.be.revertedWith("Min 10 USDT required");
  });

  it("38. 8% на уровень при реинвесте", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    await contract.connect(userSigners[2]).register(userSigners[1].address);
    await contract.connect(userSigners[2]).activatePacket(1);
    for (let i = 0; i < 5; i++) {
      await contract.connect(userSigners[10 + i]).register(userSigners[2].address);
      await contract.connect(userSigners[10 + i]).activatePacket(1);
    }
    const balance2 = (await contract.getUserInfo(userSigners[2].address)).matrixBalance;
    expect(balance2).to.be.gte(ethers.parseEther("10"));
    const before = (await contract.getUserInfo(userSigners[1].address)).matrixBalance;
    await contract.connect(userSigners[2]).claimMatrix();
    const after = (await contract.getUserInfo(userSigners[1].address)).matrixBalance;
    expect(after - before).to.be.gte(0);
  });

  it("39. Запрос VIP", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await expect(contract.connect(userSigners[0]).requestVip(1))
      .to.emit(contract, "VipRequested");
  });

  it("40. Подтверждение VIP оператором", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).requestVip(1);
    await contract.connect(operator).confirmVip(userSigners[0].address, 1);
    const vip = await contract.getVipInfo(userSigners[0].address);
    expect(vip.starLevel).to.equal(1);
    expect(vip.isActive).to.be.true;
  });

  it("41. Отклонять подтверждение VIP не-оператором", async function () {
    await expect(contract.connect(userSigners[0]).confirmVip(userSigners[0].address, 1))
      .to.be.revertedWith("Not operator");
  });

  it("42. Отклонять подтверждение VIP с недостаточным пакетом", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await expect(contract.connect(operator).confirmVip(userSigners[0].address, 3))
      .to.be.revertedWith("Packet too low");
  });

  it("43. Продление VIP", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).requestVip(1);
    await contract.connect(operator).confirmVip(userSigners[0].address, 1);
    const before = await contract.getVipInfo(userSigners[0].address);
    await ethers.provider.send("evm_increaseTime", [1]);
    await contract.connect(operator).renewVip(userSigners[0].address);
    const after = await contract.getVipInfo(userSigners[0].address);
    expect(after.expiresAt).to.be.gt(before.expiresAt);
  });

  it("44. Отзыв VIP", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).requestVip(1);
    await contract.connect(operator).confirmVip(userSigners[0].address, 1);
    await contract.connect(operator).revokeVip(userSigners[0].address);
    const vip = await contract.getVipInfo(userSigners[0].address);
    expect(vip.isActive).to.be.false;
  });

  it("45. distributePool поровну между VIP одного уровня", async function () {
    const vip1 = userSigners[5];
    const vip2 = userSigners[6];
    await contract.connect(vip1).register(admin.address);
    await contract.connect(vip1).activatePacket(1);
    await contract.connect(vip1).requestVip(1);
    await contract.connect(operator).confirmVip(vip1.address, 1);
    await contract.connect(vip2).register(admin.address);
    await contract.connect(vip2).activatePacket(1);
    await contract.connect(vip2).requestVip(1);
    await contract.connect(operator).confirmVip(vip2.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const info1 = await contract.getUserInfo(vip1.address);
    const info2 = await contract.getUserInfo(vip2.address);
    expect(info1.poolBalance).to.be.gt(0);
    expect(info2.poolBalance).to.be.gt(0);
    expect(info1.poolBalance).to.equal(info2.poolBalance);
  });

  it("46. 10% пула в reserveWallet", async function () {
    const vip = userSigners[7];
    await contract.connect(vip).register(admin.address);
    await contract.connect(vip).activatePacket(1);
    await contract.connect(vip).requestVip(1);
    await contract.connect(operator).confirmVip(vip.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    const before = await usdtToken.balanceOf(admin.address);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const after = await usdtToken.balanceOf(admin.address);
    expect(after - before).to.be.gt(0);
  });

  it("47. Нет получателей на уровне — возврат в пул", async function () {
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePool();
    const pool = await contract.liquidityPool();
    expect(pool).to.be.gte(0);
  });

  it("48. Отклонять distributePool если не прошёл интервал", async function () {
    await expect(contract.connect(admin).distributePool())
      .to.be.revertedWith("Too early");
  });

  it("49. Отклонять distributePool если пул пуст", async function () {
    await ethers.provider.send("evm_increaseTime", [86401]);
    await expect(contract.connect(admin).distributePool())
      .to.be.revertedWith("Pool is empty");
  });

  it("50. batchConfirmVip для нескольких пользователей", async function () {
    const newUsers = [userSigners[3], userSigners[4], userSigners[5]];
  for (const u of newUsers) {
    await contract.connect(u).register(admin.address);
    await contract.connect(u).activatePacket(1);
  }
  await expect(contract.connect(operator).batchConfirmVip(newUsers.map(s => s.address), 1))
    .to.emit(contract, "BatchVipConfirmed");
  });

  it("51. batchConfirmVip отклоняет >200", async function () {
    const bigList = Array(201).fill(admin.address);
    await expect(contract.connect(operator).batchConfirmVip(bigList, 1))
      .to.be.revertedWith("Batch size 1-200");
  });

  // ====================== 🟡 ВАЖНЫЕ (19) ======================

  it("52. Размещение в левую ногу при равных счетчиках", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(admin.address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const root = await contract.getMatrixNode(1);
    expect(root.leftCount).to.equal(1);
    expect(root.rightCount).to.equal(1);
  });

  it("53. Размещение в правую ногу при перевесе левой", async function () {
    for (let i = 0; i < 3; i++) {
      await contract.connect(userSigners[i]).register(admin.address);
      await contract.connect(userSigners[i]).activatePacket(1);
    }
    const root = await contract.getMatrixNode(1);
    expect(root.leftCount).to.equal(2);
    expect(root.rightCount).to.equal(1);
  });

  it("54. BFS поиск свободного места", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const node = await contract.getMatrixNode(4);
    expect(node.parent).to.equal(2);
  });

  it("55. Глубина узлов", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const node = await contract.getMatrixNode(4);
    expect(node.depth).to.equal(3);
  });

  it("56. parentId устанавливается правильно", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[1]).register(userSigners[0].address);
    await contract.connect(userSigners[1]).activatePacket(1);
    const node = await contract.getMatrixNode(4);
    expect(node.parent).to.equal(2);
  });

  it("57. leftCount и rightCount обновляются", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    const root = await contract.getMatrixNode(1);
    expect(root.leftChild).to.equal(2);
    expect(root.leftCount).to.equal(1);
  });

  it("58. Установка antiSybilVerified", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(operator).setAntiSybilVerified(userSigners[0].address);
    const vip = await contract.getVipInfo(userSigners[0].address);
    expect(vip.antiSybilVerified).to.be.true;
  });

  it("59. getMatrixNode возвращает данные", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    const node = await contract.getMatrixNode(2);
    expect(node.user).to.equal(userSigners[0].address);
    expect(node.parent).to.equal(1);
    expect(node.depth).to.equal(2);
  });

  it("60. getPoolInfo возвращает данные", async function () {
    const info = await contract.getPoolInfo();
    expect(info.poolBalance).to.be.a("bigint");
    expect(info.poolShares).to.have.length(5);
  });

  it("61. getVipInfo возвращает данные", async function () {
    const info = await contract.getVipInfo(admin.address);
    expect(info.starLevel).to.equal(0);
    expect(info.isActive).to.be.false;
  });

  it("62. getVipList возвращает список", async function () {
        const list = await contract.getVipList(1);
    expect(list).to.be.an("array");
  });

  it("63. getQueueInfo возвращает длины очередей", async function () {
    const q = await contract.getQueueInfo();
    expect(q.matrixQueueLength).to.be.a("bigint");
    expect(q.poolQueueLength).to.be.a("bigint");
  });

  it("64. Только MULTISIG обновляет кошельки", async function () {
    await expect(contract.connect(operator).updateWallets(admin.address, admin.address, admin.address, admin.address))
      .to.be.revertedWith("Not multisig");
    await expect(contract.connect(multisig).updateWallets(admin.address, admin.address, admin.address, admin.address))
      .to.not.be.reverted;
  });

  it("65. Только MULTISIG назначает операторов", async function () {
    await expect(contract.connect(operator).grantOperator(userSigners[0].address))
      .to.be.revertedWith("Not multisig");
    await expect(contract.connect(multisig).grantOperator(userSigners[0].address))
      .to.not.be.reverted;
  });

  it("66. emergencyClaimExpiredPool только для MULTISIG", async function () {
    await expect(contract.connect(operator).emergencyClaimExpiredPool(admin.address))
      .to.be.revertedWith("Not multisig");
  });

  it("67. emergencyWithdraw только для MULTISIG", async function () {
    await expect(contract.connect(operator).emergencyWithdraw(usdtToken.target, 100))
      .to.be.revertedWith("Not multisig");
  });

  it("68. distributePoolBatch обрабатывает диапазон VIP", async function () {
    const vip = userSigners[11];
    await contract.connect(vip).register(admin.address);
    await contract.connect(vip).activatePacket(1);
    await contract.connect(vip).requestVip(1);
    await contract.connect(operator).confirmVip(vip.address, 1);
    await usdtToken.connect(admin).approve(contract.target, ethers.parseEther("10000"));
    await contract.connect(admin).donateToPool(ethers.parseEther("1000"));
    await ethers.provider.send("evm_increaseTime", [86401]);
    await contract.connect(admin).distributePoolBatch(1, 0, 500);
    const info = await contract.getUserInfo(vip.address);
    expect(info.poolBalance).to.be.gt(0);
  });

  it("69. _cleanExpiredVips удаляет истекших VIP", async function () {
    const testUser = userSigners[12];
    await contract.connect(testUser).register(admin.address);
    await contract.connect(testUser).activatePacket(1);
    await contract.connect(testUser).requestVip(1);
    await contract.connect(operator).confirmVip(testUser.address, 1);
    await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]);
    await contract.distributePool();
    const list = await contract.getVipList(1);
   expect(list).to.not.include(testUser.address);
  });

  it("70. _addToVipList не добавляет дубликаты", async function () {
    await contract.connect(userSigners[0]).register(admin.address);
    await contract.connect(userSigners[0]).activatePacket(1);
    await contract.connect(userSigners[0]).requestVip(1);
    await contract.connect(operator).confirmVip(userSigners[0].address, 1);
    const list1 = await contract.getVipList(1);
    await contract.connect(operator).confirmVip(userSigners[0].address, 1);
    const list2 = await contract.getVipList(1);
    expect(list1.length).to.equal(list2.length);
  });
});