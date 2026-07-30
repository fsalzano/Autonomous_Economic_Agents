import hre from "hardhat";

async function main() {
  console.log("=================================================");
  console.log("   DEPLOYING AEA ECONOMIC AGENT CONTRACT         ");
  console.log("=================================================\n");

  const [deployer] = await hre.ethers.getSigners();

  console.log(`👤 Deployer Account: ${deployer.address}`);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`💰 Account Balance:    ${hre.ethers.formatEther(balance)} SepoliaETH\n`);

  const EAC = await hre.ethers.getContractFactory("AEAEconomicAgentContract");

  console.log("🚀 Sending deploy transaction to Sepolia...");
  const eac = await EAC.deploy(deployer.address);
  await eac.waitForDeployment();

  const deployedAddress = await eac.getAddress();

  console.log("\n=================================================");
  console.log(`✅ CONTRACT DEPLOYED SUCCESSFULLY!`);
  console.log(`📍 Address: ${deployedAddress}`);
  console.log("=================================================");
  console.log("\n👉 Update the .env file setting:");
  console.log(`CONTRACT_ADDRESS=${deployedAddress}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});