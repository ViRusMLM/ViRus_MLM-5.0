import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
      viaIR: true,
    },
  },
    networks: {
    bscTestnet: {
      url: "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts: ["0x56aa1b62cab0573188b738b5f846d47b620f72593ca962278df2adfe2eab1bea"],
      gasPrice: 10000000000, // 10 Gwei (минимальное значение для тестнета)
    },
  },
  etherscan: {
    apiKey: {
      bscTestnet: "INRKA8AKZVW8CYYM3Y4P6E5HVK1P379SKI"
    },
    customChains: [
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=97",
          browserURL: "https://testnet.bscscan.com"
        }
      }
    ]
  },
};

export default config;