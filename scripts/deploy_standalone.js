import dotenv from 'dotenv';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import solc from 'solc';

dotenv.config();

async function main() {
    console.log("=================================================");
    console.log("   DEPLOY STANDALONE (PURE ETHERS.JS)            ");
    console.log("=================================================\n");

    const RPC_URL = process.env.SEPOLIA_RPC_URL;
    const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

    if (!RPC_URL || !DEPLOYER_KEY) {
        console.error("❌ ERRORE: SEPOLIA_RPC_URL o DEPLOYER_PRIVATE_KEY mancanti nel .env");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`👤 Deployer Account: ${wallet.address}`);
    const balance = await provider.getBalance(wallet.address);
    console.log(`💰 Saldo Account:    ${ethers.formatEther(balance)} SepoliaETH\n`);

    // 1. Lettura del codice Solidity
    const contractPath = path.resolve('contracts', 'AEAEconomicAgentContract.sol');
    if (!fs.existsSync(contractPath)) {
        console.error(`❌ File non trovato: ${contractPath}`);
        process.exit(1);
    }
    const sourceCode = fs.readFileSync(contractPath, 'utf8');

    // 2. Compilazione al volo con solc
    console.log("⚙️  Compilazione dello smart contract con solc 0.8.20...");
    const input = {
        language: 'Solidity',
        sources: {
            'AEAEconomicAgentContract.sol': {
                content: sourceCode
            }
        },
        settings: {
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode']
                }
            }
        }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    
    if (output.errors) {
        const severeErrors = output.errors.filter(e => e.severity === 'error');
        if (severeErrors.length > 0) {
            console.error("❌ Errore durante la compilazione:");
            console.error(severeErrors);
            process.exit(1);
        }
    }

    const contractData = output.contracts['AEAEconomicAgentContract.sol']['AEAEconomicAgentContract'];
    const abi = contractData.abi;
    const bytecode = contractData.evm.bytecode.object;

    // 3. Deploy su Sepolia
    console.log("🚀 Invio transazione di deploy su Sepolia...");
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const contract = await factory.deploy(wallet.address);
    
    await contract.waitForDeployment();
    const deployedAddress = await contract.getAddress();

    console.log("\n=================================================");
    console.log(`✅ CONTRATTO DEPLOYATO CON SUCCESSO!`);
    console.log(`📍 Indirizzo: ${deployedAddress}`);
    console.log("=================================================");
    console.log(`\n👉 Copia questo indirizzo nel tuo .env alla voce CONTRACT_ADDRESS!`);
}

main().catch(console.error);
