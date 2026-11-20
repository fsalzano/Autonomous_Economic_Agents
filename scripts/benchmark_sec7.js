import dotenv from "dotenv";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

dotenv.config();

const EAC_ABI = [
    "function setConstitution(uint256 agentId, uint256 aiBudget, uint256 econBudget, bytes32 toolAllowlistRoot, uint16 maxDepth) external",
    "function authorizeAction(uint256 agentId, uint256 requestedTokens) external view returns (bool isAllowed)",
    "function settleActionBatch(uint256 agentId, uint256 totalTokensConsumed, uint256 actionCount, bytes32 batchAuditRoot) external"
];

const RPC_URL = process.env.SEPOLIA_RPC_URL;
const ADMIN_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SAMPLES = Number(process.env.BENCHMARK_SAMPLES ?? 1000);
const WARMUP_CALLS = Number(process.env.BENCHMARK_WARMUPS ?? 20);
const BATCH_RUNS = Number(process.env.BENCHMARK_BATCH_RUNS ?? 3);
const REQUESTED_TOKENS = BigInt(process.env.REQUESTED_TOKENS ?? 100);
const TOKENS_PER_BATCH = BigInt(process.env.TOKENS_PER_BATCH ?? 100000);
const ETH_PRICE_USD = Number(process.env.ETH_PRICE_USD ?? Number.NaN);
const ETH_PRICE_DATE = process.env.ETH_PRICE_DATE ?? null;
const REPORT_USD = Number.isFinite(ETH_PRICE_USD) && ETH_PRICE_DATE !== null;
const OUTPUT_DIR = process.env.BENCHMARK_OUTPUT_DIR ?? "benchmark_results";

if (Number.isFinite(ETH_PRICE_USD) && ETH_PRICE_DATE === null) {
    throw new Error(
        "ETH_PRICE_USD was supplied without ETH_PRICE_DATE. An undated price " +
        "cannot be used to derive a cost. Set ETH_PRICE_DATE as well."
    );
}
if (!RPC_URL || !ADMIN_KEY || !CONTRACT_ADDRESS) {
    throw new Error("Missing SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, or CONTRACT_ADDRESS in .env");
}
if (!Number.isInteger(SAMPLES) || SAMPLES < 2) {
    throw new Error("BENCHMARK_SAMPLES must be an integer >= 2.");
}
if (!Number.isInteger(WARMUP_CALLS) || WARMUP_CALLS < 0) {
    throw new Error("BENCHMARK_WARMUPS must be a non-negative integer.");
}
if (!Number.isInteger(BATCH_RUNS) || BATCH_RUNS < 2) {
    throw new Error("BENCHMARK_BATCH_RUNS must be >= 2 to distinguish first-use and steady-state settlement costs.");
}
if (REPORT_USD && ETH_PRICE_USD <= 0) {
    throw new Error("ETH_PRICE_USD must be a positive number.");
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStdDev(values) {
    const avg = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function percentile(sortedValues, probability) {
    if (sortedValues.length === 1) return sortedValues[0];
    const index = (sortedValues.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function latencyStats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const avg = mean(values);
    const stdDev = sampleStdDev(values);
    const margin = 1.96 * stdDev / Math.sqrt(values.length);
    return {
        samples: values.length,
        meanMs: avg,
        medianMs: percentile(sorted, 0.5),
        stdDevMs: stdDev,
        minMs: sorted[0],
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        maxMs: sorted[sorted.length - 1],
        ci95LowMs: avg - margin,
        ci95HighMs: avg + margin
    };
}

function formatNumber(value, decimals = 2) {
    return Number(value).toFixed(decimals);
}

function safeRpcHost(url) {
    try { return new URL(url).hostname; } catch { return "unknown"; }
}

function bigintJsonReplacer(_key, value) {
    return typeof value === "bigint" ? value.toString() : value;
}

function usdLabel(metrics, decimals = 5) {
    return REPORT_USD ? `, projectedUSD=${formatNumber(metrics.projectedCostUsd, decimals)}` : "";
}

async function readTransactionMetrics(provider, transactionResponse, startedAtMs) {
    const receipt = await transactionResponse.wait();
    if (!receipt) throw new Error(`No receipt returned for transaction ${transactionResponse.hash}`);
    let effectiveGasPriceWei = receipt.gasPrice;
    if (effectiveGasPriceWei == null) {
        const minedTransaction = await provider.getTransaction(receipt.hash);
        effectiveGasPriceWei = minedTransaction?.gasPrice ?? null;
    }
    if (effectiveGasPriceWei == null) {
        throw new Error(`Unable to determine the effective gas price for transaction ${receipt.hash}`);
    }
    const feeWei = receipt.fee ?? receipt.gasUsed * effectiveGasPriceWei;
    const feeEth = Number(ethers.formatEther(feeWei));
    return {
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei,
        effectiveGasPriceGwei: Number(ethers.formatUnits(effectiveGasPriceWei, "gwei")),
        feeWei,
        feeEth,
        ...(REPORT_USD ? { projectedCostUsd: feeEth * ETH_PRICE_USD } : {}),
        confirmationLatencyMs: performance.now() - startedAtMs
    };
}

async function sendAndMeasure(provider, sendTransaction) {
    const startedAtMs = performance.now();
    return readTransactionMetrics(provider, await sendTransaction(), startedAtMs);
}

async function runBenchmark() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const adminWallet = new ethers.Wallet(ADMIN_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, EAC_ABI, adminWallet);
    const network = await provider.getNetwork();
    const startBlockNumber = await provider.getBlockNumber();
    const startBlock = await provider.getBlock(startBlockNumber);
    const feeSnapshot = await provider.getFeeData();

    if (network.chainId !== 11155111n) {
        console.warn(`Warning: expected Sepolia chainId 11155111, but connected to ${network.chainId}.`);
    }
    const agentId = process.env.BENCHMARK_AGENT_ID
        ? BigInt(process.env.BENCHMARK_AGENT_ID)
        : BigInt(Date.now());

    console.log("========================================================");
    console.log(" Governance benchmark: Ethereum Sepolia");
    console.log("========================================================");
    console.log(`Contract:              ${CONTRACT_ADDRESS}`);
    console.log(`Admin:                 ${adminWallet.address}`);
    console.log(`RPC host:              ${safeRpcHost(RPC_URL)}`);
    console.log(`Chain ID:              ${network.chainId}`);
    console.log(`Start block:           ${startBlockNumber}`);
    console.log(`Start block UTC:       ${startBlock ? new Date(Number(startBlock.timestamp) * 1000).toISOString() : "unknown"}`);
    console.log(`Fresh benchmark agent: ${agentId}`);
    console.log(`Samples:               ${SAMPLES}`);
    console.log(`Warm-up calls:         ${WARMUP_CALLS}`);
    console.log(`Settlement runs:       ${BATCH_RUNS}`);
    console.log(REPORT_USD
        ? `ETH/USD reference:     ${ETH_PRICE_USD} (${ETH_PRICE_DATE})`
        : "ETH/USD reference:     not reported (set ETH_PRICE_USD and ETH_PRICE_DATE to enable)");
    if (feeSnapshot.gasPrice != null) {
        console.log(`Pre-run fee estimate:  ${ethers.formatUnits(feeSnapshot.gasPrice, "gwei")} Gwei`);
    }

    const aiBudget = 10_000_000_000n;
    const econBudget = ethers.parseEther("0.1");
    const allowlistRoot = ethers.keccak256(ethers.toUtf8Bytes(`ALLOWLIST_ROOT_BENCHMARK_${agentId}`));
    const setConstitution = await sendAndMeasure(provider, () => contract.setConstitution(
        agentId, aiBudget, econBudget, allowlistRoot, 3
    ));
    console.log(`1. Policy initialization: gas=${setConstitution.gasUsed}, effectiveGasPrice=${formatNumber(setConstitution.effectiveGasPriceGwei, 6)} Gwei${usdLabel(setConstitution)}`);

    console.log(`\n2. Running ${WARMUP_CALLS} authorization warm-up calls...`);
    for (let i = 0; i < WARMUP_CALLS; i++) {
        await contract.authorizeAction(agentId, REQUESTED_TOKENS);
    }
    const authorizeGasEstimate = await contract.authorizeAction.estimateGas(agentId, REQUESTED_TOKENS);

    console.log(`3. Measuring ${SAMPLES} sequential authorization calls...`);
    const latencies = [];
    let failedAuthorizations = 0;
    for (let i = 0; i < SAMPLES; i++) {
        const startedAtMs = performance.now();
        const isAllowed = await contract.authorizeAction(agentId, REQUESTED_TOKENS);
        latencies.push(performance.now() - startedAtMs);
        if (!isAllowed) failedAuthorizations++;
        if ((i + 1) % 100 === 0 || i === SAMPLES - 1) {
            console.log(`   completed ${i + 1}/${SAMPLES}`);
        }
    }
    const authorization = latencyStats(latencies);
    console.log(`   mean=${formatNumber(authorization.meanMs)} ms, median=${formatNumber(authorization.medianMs)} ms, std=${formatNumber(authorization.stdDevMs)} ms, p95=${formatNumber(authorization.p95Ms)} ms`);
    if (failedAuthorizations > 0) console.warn(`   Warning: ${failedAuthorizations}/${SAMPLES} calls returned false.`);
    fs.writeFileSync(path.join(OUTPUT_DIR, "authorize_latencies.csv"), [
        "sample,latency_ms",
        ...latencies.map((latency, index) => `${index + 1},${latency.toFixed(6)}`)
    ].join("\n"));

    console.log(`\n4. Executing ${BATCH_RUNS} settlements of ${SAMPLES} actions each...`);
    const settlements = [];
    for (let i = 0; i < BATCH_RUNS; i++) {
        const auditRoot = ethers.keccak256(ethers.toUtf8Bytes(`BATCH_AUDIT_ROOT_${agentId}_${i}_${Date.now()}`));
        const metrics = await sendAndMeasure(provider, () => contract.settleActionBatch(
            agentId, TOKENS_PER_BATCH, SAMPLES, auditRoot
        ));
        settlements.push(metrics);
        console.log(`   run=${i + 1}, gas=${metrics.gasUsed}, effectiveGasPrice=${formatNumber(metrics.effectiveGasPriceGwei, 6)} Gwei${usdLabel(metrics)}`);
    }

    const firstSettlement = settlements[0];
    const steadyStateSettlements = settlements.slice(1);
    const steadyGasMean = mean(steadyStateSettlements.map(item => Number(item.gasUsed)));
    const steadyGasPriceGweiMean = mean(steadyStateSettlements.map(item => item.effectiveGasPriceGwei));
    const steadyCostUsdMean = REPORT_USD
        ? mean(steadyStateSettlements.map(item => item.projectedCostUsd))
        : null;
    const projectedCostPerActionUsd = REPORT_USD ? steadyCostUsdMean / SAMPLES : null;
    const results = {
        benchmark: {
            timestampUtc: new Date().toISOString(),
            rpcHost: safeRpcHost(RPC_URL),
            chainId: network.chainId,
            startBlockNumber,
            startBlockTimestampUtc: startBlock
                ? new Date(Number(startBlock.timestamp) * 1000).toISOString()
                : null,
            contractAddress: CONTRACT_ADDRESS,
            adminAddress: adminWallet.address,
            agentId,
            compiler: "solc 0.8.20; optimizer enabled; 200 runs",
            ...(REPORT_USD ? { ethPriceUsd: ETH_PRICE_USD, ethPriceDate: ETH_PRICE_DATE } : {}),
            samples: SAMPLES,
            warmupCalls: WARMUP_CALLS,
            batchRuns: BATCH_RUNS
        },
        setConstitution,
        authorizeAction: {
            invocation: "eth_call",
            gasEstimate: authorizeGasEstimate,
            failedAuthorizations,
            ...authorization
        },
        settleActionBatch: {
            actionsPerBatch: SAMPLES,
            tokensPerBatch: TOKENS_PER_BATCH,
            firstSettlement,
            steadyStateRuns: steadyStateSettlements,
            steadyGasMean,
            steadyGasPriceGweiMean,
            ...(REPORT_USD ? {
                steadyProjectedCostUsdMean: steadyCostUsdMean,
                steadyProjectedCostPerActionUsd: projectedCostPerActionUsd
            } : {})
        }
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, "benchmark_sec7_results.json"), JSON.stringify(results, bigintJsonReplacer, 2));

    console.log("\n========================================================");
    console.log(" PAPER RESULTS");
    console.log("========================================================");
    console.log(`setConstitution: gas=${setConstitution.gasUsed}, effectiveGasPrice=${formatNumber(setConstitution.effectiveGasPriceGwei, 4)} Gwei${usdLabel(setConstitution)}`);
    console.log(`authorizeAction: N=${SAMPLES}, gasEstimate=${authorizeGasEstimate}, mean=${formatNumber(authorization.meanMs)} ms, median=${formatNumber(authorization.medianMs)} ms, std=${formatNumber(authorization.stdDevMs)} ms, p95=${formatNumber(authorization.p95Ms)} ms, p99=${formatNumber(authorization.p99Ms)} ms, 95%CI=[${formatNumber(authorization.ci95LowMs)}, ${formatNumber(authorization.ci95HighMs)}] ms`);
    console.log(`first settlement: gas=${firstSettlement.gasUsed}, effectiveGasPrice=${formatNumber(firstSettlement.effectiveGasPriceGwei, 4)} Gwei${usdLabel(firstSettlement)}`);
    console.log(`steady settlement (${steadyStateSettlements.length} runs): meanGas=${formatNumber(steadyGasMean, 0)}, meanEffectiveGasPrice=${formatNumber(steadyGasPriceGweiMean, 4)} Gwei${REPORT_USD ? `, meanProjectedUSD=${formatNumber(steadyCostUsdMean, 5)}, projectedUSDPerAction=${projectedCostPerActionUsd.toExponential(3)}` : ""}`);
    console.log(`Results written to: ${OUTPUT_DIR}`);
    console.log("========================================================");
}

runBenchmark().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
