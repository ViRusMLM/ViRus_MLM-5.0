const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("VirusMLM V5", function () {
  it("Should deploy", async function () {
    const [owner] = await ethers.getSigners();
    const VirusMLM = await ethers.getContractFactory("VirusMLM");
    const contract = await VirusMLM.deploy(
      owner.address, // usdtToken (заглушка)
      owner.address, // reinvestFeeWallet
      owner.address, // gamePoolWallet
      owner.address, // reserveWallet
      owner.address, // rootId
      owner.address  // developmentFundWallet
    );
    await contract.waitForDeployment();
    expect(await contract.totalUsers()).to.equal(1);
  });
});