require("dotenv").config();
const express = require("express");
const { ethers } = require("ethers");

const app = express();
app.use(express.json());

// --- BLOCKCHAIN & CONTRACT CONFIGURATION ---
const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
const EAC_ADDRESS = process.env.EAC_CONTRACT_ADDRESS;

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Minimum ABI for policy interrogation and verification only
const EAC_ABI = [
    "function authorizeAction(uint256 agentId, uint256 requestedTokens) view returns (bool)",
    "function constitutions(uint256) view returns (uint256 aiBudgetPerEpoch, uint256 econBudgetPerEpoch, bytes32 toolAllowlistRoot, uint16 maxInferenceDepth, bool active, bool emergencyStop)"
];

const eacContract = new ethers.Contract(EAC_ADDRESS, EAC_ABI, provider);

// Registered Codex Agent ID in the contract
const CODEX_AGENT_ID = process.env.CODEX_AGENT_ID || 8004;

// --- OFF-CHAIN CACHING & BATCHING STRUCTURES ---
let actionLogBatch = [];
const BATCH_SIZE_THRESHOLD = 100; // N = 100 for batched settlement

// Local cache to simulate high-speed verification (Latency ~0.04 ms)
let localCredentialCache = {
    active: true,
    emergencyStop: false,
    lastSync: Date.now()
};

/**
 * Helper function to simulate real Codex invocation (LLM + Tool Execution)
 */
async function invokeCodexAgentEngine(prompt, requestedTools) {
    // Connect real Codex agent SDK here (e.g. LangGraph, OpenAI API, etc.)
    // Return processing result and consumed tokens
    return {
        output: `[Codex Result]: Task completed successfully for prompt: "${prompt}"`,
        tokensUsed: 420 // Tokens actually consumed during inference
    };
}

// =========================================================================
// GOVERNANCE ROUTE (PEP): Intercepts and executes Codex requests
// =========================================================================
app.post("/api/v1/codex/execute", async (req, res) => {
    const { prompt, estimatedTokens, useCache } = req.body;

    if (!prompt || !estimatedTokens) {
        return res.status(400).json({ error: "Missing prompt or estimatedTokens parameters" });
    }

    console.log(`\n[Gateway PEP] Received request for Codex (ID: ${CODEX_AGENT_ID})`);
    console.log(`[Gateway PEP] Estimated tokens: ${estimatedTokens} | Cache Mode: ${useCache ? "ON" : "OFF"}`);

    try {
        let isAllowed = false;
        const startTime = performance.now();

        // 1. EVALUATION (PDP Check)
        if (useCache) {
            // Caching Mode: Ultra-fast in-memory check
            isAllowed = localCredentialCache.active && !localCredentialCache.emergencyStop;
        } else {
            // Direct View Call Mode: Read-only RPC call to Smart Contract
            isAllowed = await eacContract.authorizeAction(CODEX_AGENT_ID, estimatedTokens);
        }

        const endTime = performance.now();
        const latency = (endTime - startTime).toFixed(4);

        console.log(`[Gateway PEP] Policy evaluation completed in ${latency} ms. Outcome: ${isAllowed ? "AUTHORIZED" : "REJECTED"}`);

        // 2. ENFORCEMENT
        if (!isAllowed) {
            return res.status(403).json({
                error: "Governance Policy Violation",
                message: "Action blocked by Gateway: Budget exceeded or Agent deactivated in On-Chain Constitution.",
                latencyMs: latency
            });
        }

        // 3. EXECUTION OF CODEX AGENT
        const agentResponse = await invokeCodexAgentEngine(prompt);

        // 4. LOGGING FOR OFF-CHAIN BATCH SETTLEMENT
        actionLogBatch.push({
            agentId: CODEX_AGENT_ID,
            tokensUsed: agentResponse.tokensUsed,
            timestamp: Date.now(),
            promptHash: ethers.keccak256(ethers.toUtf8Bytes(prompt))
        });

        console.log(`[Batch Tracker] Log recorded off-chain. Current batch size: ${actionLogBatch.length}/${BATCH_SIZE_THRESHOLD}`);

        // 5. RESPONSE TO CLIENT
        return res.json({
            status: "SUCCESS",
            data: agentResponse.output,
            governance: {
                authorized: true,
                authorizationLatencyMs: parseFloat(latency),
                tokensConsumed: agentResponse.tokensUsed,
                batchStatus: `${actionLogBatch.length}/${BATCH_SIZE_THRESHOLD} queued`
            }
        });

    } catch (error) {
        console.error("[Gateway PEP] Error during execution:", error.message);
        return res.status(500).json({ error: "Internal Gateway Error", details: error.message });
    }
});

// Starting the Gateway server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`  AEA GOVERNANCE GATEWAY LISTENING ON PORT ${PORT}`);
    console.log(`=================================================`);
});