#!/usr/bin/env node

import {
  SolanaAdapter,
  EthereumAdapter,
  BalanceAggregator,
} from "@proofoflove/chain-adapters";
import {
  WealthProver,
  WealthVerifier,
  generateNullifier,
  getTierBadge,
  formatBalance,
} from "@proofoflove/core";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Main CLI demo for Proof of Love ZK wealth verification
 */
async function main() {
  console.log("========================================");
  console.log("Proof of Love - ZK Wealth Verification");
  console.log("========================================\n");

  // Step 1: Load configuration
  console.log("Loading configuration...");
  let config: any;
  try {
    config = JSON.parse(
      await fs.readFile(path.join(__dirname, "config.json"), "utf-8"),
    );
  } catch (error) {
    console.error("✗ Failed to load config.json");
    console.error(
      "Please copy config.example.json to config.json and add your API keys\n",
    );
    process.exit(1);
  }

  // Step 2: Initialize chain adapters
  console.log("Initializing chain adapters...\n");

  const solanaAdapter = new SolanaAdapter({
    apiKey: config.heliusApiKey,
    network: "mainnet-beta",
  });

  const ethAdapter = new EthereumAdapter({
    apiKey: config.ethereumRpcUrl,
    network: "ethereum",
  });

  const arbitrumAdapter = new EthereumAdapter({
    apiKey: config.arbitrumRpcUrl,
    network: "arbitrum",
  });

  const baseAdapter = new EthereumAdapter({
    apiKey: config.baseRpcUrl,
    network: "base",
  });

  const hyperevmAdapter = new EthereumAdapter({
    apiKey: config.hyperevmRpcUrl || "https://rpc.hyperliquid.xyz/evm",
    network: "hyperevm",
  });

  const aggregator = new BalanceAggregator();
  aggregator.registerAdapter(solanaAdapter);
  aggregator.registerAdapter(ethAdapter);
  aggregator.registerAdapter(arbitrumAdapter);
  aggregator.registerAdapter(baseAdapter);
  aggregator.registerAdapter(hyperevmAdapter);

  console.log(
    `✓ Registered chains: ${aggregator.getRegisteredChains().join(", ")}\n`,
  );

  // Step 3: Prepare wallet list
  const wallets: Array<{ chain: string; address: string }> = [
    ...(config.testWallets.solana || []).map((addr: string) => ({
      chain: "solana",
      address: addr,
    })),
    ...(config.testWallets.ethereum || []).map((addr: string) => ({
      chain: "ethereum",
      address: addr,
    })),
    ...(config.testWallets.arbitrum || []).map((addr: string) => ({
      chain: "arbitrum",
      address: addr,
    })),
    ...(config.testWallets.base || []).map((addr: string) => ({
      chain: "base",
      address: addr,
    })),
    ...(config.testWallets.hyperevm || []).map((addr: string) => ({
      chain: "hyperevm",
      address: addr,
    })),
  ];

  console.log("Connected wallets:");
  wallets.forEach((w, i) => {
    console.log(`  ${i + 1}. ${w.chain}: ${w.address}`);
  });
  console.log("");

  // Step 4: Generate snapshots (now, ~30d ago, ~60d ago)
  const snapshots = BalanceAggregator.generateSnapshots();
  console.log("Fetching balances at 3 snapshots:");
  snapshots.forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.date.toLocaleDateString()} (${s.unixTimestamp})`,
    );
  });
  console.log("");

  // Step 5: Fetch and aggregate balances
  console.log(
    "Fetching historical balances (this may take 30-60 seconds)...\n",
  );

  let aggregatedBalances: [number, number, number];
  try {
    aggregatedBalances = await aggregator.aggregateBalances(wallets, snapshots);
  } catch (error) {
    console.error("✗ Failed to aggregate balances:", error);
    process.exit(1);
  }

  const avgBalance = Math.floor(
    (aggregatedBalances[0] + aggregatedBalances[1] + aggregatedBalances[2]) / 3,
  );
  console.log(`\nAverage balance: ${formatBalance(avgBalance)}\n`);

  // Step 6: Generate nullifier
  console.log("Generating nullifier...");
  const userSecret = config.userSecret;
  const nullifier = await generateNullifier(
    wallets.map((w) => w.address),
    userSecret,
  );
  console.log(`✓ Nullifier: ${nullifier.toString().slice(0, 16)}...\n`);

  // Step 7: Generate ZK proof
  console.log("Generating zero-knowledge proof...");
  console.log("(This may take 5-15 seconds)\n");

  // __dirname = packages/demo/src → ../../circuits/build = packages/circuits/build
  const circuitBuildPath = path.resolve(__dirname, "../../circuits/build");
  const wasmPath = path.join(
    circuitBuildPath,
    "wealth_tier_js/wealth_tier.wasm",
  );
  const zkeyPath = path.join(circuitBuildPath, "keys/wealth_tier_final.zkey");

  const prover = new WealthProver(wasmPath, zkeyPath);

  let proofData;
  try {
    proofData = await prover.generateProof(aggregatedBalances, nullifier);
  } catch (error) {
    console.error("✗ Proof generation failed:", error);
    console.error("\nMake sure to compile the circuit first:");
    console.error("  cd packages/circuits");
    console.error("  ./scripts/compile.sh");
    console.error("  ./scripts/setup.sh\n");
    process.exit(1);
  }

  console.log(`✅ Proof generated successfully!`);
  console.log(`   Tier: ${getTierBadge(proofData.tier)}`);
  console.log(
    `   Timestamp: ${new Date(proofData.timestamp * 1000).toISOString()}\n`,
  );

  // Step 8: Save proof to file
  const proofOutputPath = path.join(__dirname, "../examples/test_proof.json");
  await fs.mkdir(path.dirname(proofOutputPath), { recursive: true });
  await fs.writeFile(proofOutputPath, JSON.stringify(proofData, null, 2));
  console.log(`💾 Proof saved to: examples/test_proof.json\n`);

  // Step 9: Verify proof
  console.log("Verifying proof...");

  const vkeyPath = path.join(circuitBuildPath, "keys/verification_key.json");
  let verifier;
  try {
    verifier = await WealthVerifier.loadFromFile(vkeyPath);
  } catch (error) {
    console.error("✗ Failed to load verification key:", error);
    process.exit(1);
  }

  const result = await verifier.verify(proofData);

  if (result.valid) {
    console.log("✅ Proof is VALID");
    console.log(`   Verified tier: ${getTierBadge(result.tier!)}`);
    console.log(`   Nullifier: ${result.nullifier?.slice(0, 16)}...`);
    console.log(
      `   Timestamp: ${new Date(result.timestamp! * 1000).toISOString()}`,
    );
  } else {
    console.log(`❌ Proof is INVALID: ${result.error}`);
    process.exit(1);
  }

  console.log("\n========================================");
  console.log("Demo complete! 🎉");
  console.log("========================================\n");

  console.log("What just happened:");
  console.log("1. ✓ Fetched real blockchain balances from Solana + EVM chains");
  console.log("2. ✓ Aggregated balances across all wallets at 3 time points");
  console.log(
    "3. ✓ Generated ZK proof using AVERAGE balance (more forgiving!)",
  );
  console.log("4. ✓ Verified the proof cryptographically");
  console.log("");
  console.log("The verifier now knows your wealth tier, but NOT:");
  console.log("  - Your exact balance amounts");
  console.log("  - Which specific wallets you own");
  console.log("  - Which blockchains your funds are on\n");
}

// Run the demo
main().catch(console.error);
