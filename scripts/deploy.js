const hre = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  const USDT_TESTNET_ADDRESS = "0x3a0C8fF4D3aB0Eaa69dA925C026fB2C2172eB517";

  const VirusMLM = await ethers.getContractFactory("VirusMLM");
  const contract = await VirusMLM.deploy(
    USDT_TESTNET_ADDRESS,
    "0x15e9Db3D2e06435De99f51b7F23B075dA71419d9",  // reinvestFeeWallet
    "0x140DE6c91aAD9709364f1614236287fBd6d1d347",  // gamePoolWallet
    "0x4068A6B661200e6eBc64C92f7f6E830C5968AD3A",  // reserveWallet
    "0x6a10645398169Efd368877075a4f94f1A6204baa",  // rootId (A)
    "0xA1953DF96e273ee16E972390cBCe85344df74AC7"   // developmentFundWallet
  );

  await contract.waitForDeployment();

  console.log("✅ Contract deployed to:", await contract.getAddress());
}

main().catch(console.error);