# ICAIF_Autonomous_Economic_Agents

This project implements a governance framework for Autonomous Economic Agents (AEAs), providing an on-chain Policy Decision Point (PDP) and an off-chain Policy Enforcement Point (PEP) via a Gateway.

## Overview

The system ensures that AEA actions (specifically for a "Codex" agent) comply with a predefined "Constitution" stored on the Ethereum Sepolia blockchain. It manages AI and economic budgets, enforces tool allowlists, and optimizes costs through batched settlement.

### Key Components

- **Smart Contract (`contracts/AEAEconomicAgentContract.sol`)**: Stores agent constitutions and tracks budget consumption.
- **Gateway PEP (`src/gateway.js`)**: An Express.js server that intercepts agent requests, checks policies (either via local cache or direct RPC calls), and logs actions for settlement.
- **Benchmark Tool (`scripts/benchmark_sec7.js`)**: Measures the performance and costs of policy initialization, authorization latency, and batched settlement.

## Getting Started

### Prerequisites

- Node.js & npm
- Hardhat
- A Sepolia RPC URL (e.g., via Alchemy or Infura)
- A private key for deployment and administration

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables by creating a `.env` file:
   ```env
   SEPOLIA_RPC_URL=your_rpc_url
   DEPLOYER_PRIVATE_KEY=your_private_key
   CONTRACT_ADDRESS=deployed_contract_address
   CODEX_AGENT_ID=8004
   ```

### Deployment

To deploy the governance contract to Sepolia:
```bash
npx hardhat run scripts/deploy.js --network sepolia
```

### Usage

**Running the Gateway:**
```bash
node src/gateway.js
```
The gateway will listen on port 3000 by default.

**Running Benchmarks:**
```bash
node scripts/benchmark_sec7.js
```
Results will be saved in the `benchmark_results` directory.

## Project Structure

- `contracts/`: Solidity smart contracts.
- `src/`: Gateway implementation.
- `scripts/`: Deployment and benchmarking scripts.
- `benchmark_results/`: Output from performance tests.
