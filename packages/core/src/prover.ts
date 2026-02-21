import { groth16 } from "snarkjs";
import { getTierForBalance } from "./tiers.js";
import type { ProofData, CircuitInputs } from "./types.js";

/**
 * Wealth tier proof generator
 * Wraps snarkjs for browser and Node.js proof generation
 */
export class WealthProver {
  private wasmPath?: string;
  private zkeyPath?: string;

  /**
   * Create a prover instance
   * @param wasmPath - Path to compiled circuit WASM file
   * @param zkeyPath - Path to proving key (zkey) file
   */
  constructor(wasmPath?: string, zkeyPath?: string) {
    this.wasmPath = wasmPath;
    this.zkeyPath = zkeyPath;
  }

  /**
   * Generate proof of wealth tier (Node.js version)
   *
   * Uses the AVERAGE of 3 balance snapshots to determine tier.
   * This is more forgiving than MIN — a temporary dip in one month
   * won't disqualify you from your tier.
   *
   * @param balances - 3 aggregated balance snapshots in USD cents
   * @param nullifier - Identity commitment (from generateNullifier)
   * @param timestamp - Unix timestamp (defaults to now)
   * @returns ProofData with proof, public signals, and tier info
   */
  async generateProof(
    balances: [number, number, number],
    nullifier: bigint,
    timestamp: number = Math.floor(Date.now() / 1000),
  ): Promise<ProofData> {
    if (!this.wasmPath || !this.zkeyPath) {
      throw new Error(
        "Prover not initialized with artifact paths. Use generateProofBrowser() instead.",
      );
    }

    // Determine tier from average balance (floor division)
    const avgBalance = Math.floor(
      (balances[0] + balances[1] + balances[2]) / 3,
    );
    const tier = getTierForBalance(avgBalance);

    console.log(`Generating proof for Tier ${tier.tier} (${tier.label})`);
    console.log(`Avg balance: ${(avgBalance / 100).toFixed(2)} USD`);

    // Prepare circuit inputs
    const inputs: CircuitInputs = {
      balance_1: balances[0].toString(),
      balance_2: balances[1].toString(),
      balance_3: balances[2].toString(),
      tier_lower_bound: tier.lowerBound.toString(),
      tier_upper_bound: tier.upperBound.toString(),
      nullifier: nullifier.toString(),
      timestamp: timestamp.toString(),
    };

    console.log("Generating witness and proof (this may take 5-15 seconds)...");

    try {
      // Read wasm file into buffer to avoid snarkjs path resolution issues
      const fs = await import("fs/promises");
      const wasmBuffer = await fs.readFile(
        this.wasmPath.endsWith(".wasm")
          ? this.wasmPath
          : `${this.wasmPath}/wealth_tier.wasm`,
      );

      const { proof, publicSignals } = await groth16.fullProve(
        inputs as unknown as Record<string, string>,
        new Uint8Array(wasmBuffer),
        this.zkeyPath,
      );

      console.log("✓ Proof generated successfully!");

      return {
        proof,
        publicSignals,
        tier: tier.tier,
        tierLabel: tier.label,
        timestamp,
      };
    } catch (error) {
      console.error("✗ Proof generation failed:", error);
      throw new Error(
        `Proof generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Generate proof in browser using ArrayBuffers
   * @param balances - 3 aggregated balance snapshots in USD cents
   * @param nullifier - Identity commitment
   * @param wasmBuffer - WASM file as ArrayBuffer
   * @param zkeyBuffer - zkey file as ArrayBuffer
   * @returns ProofData with proof, public signals, and tier info
   */
  async generateProofBrowser(
    balances: [number, number, number],
    nullifier: bigint,
    wasmBuffer: ArrayBuffer,
    zkeyBuffer: ArrayBuffer,
  ): Promise<ProofData> {
    const avgBalance = Math.floor(
      (balances[0] + balances[1] + balances[2]) / 3,
    );
    const tier = getTierForBalance(avgBalance);
    const timestamp = Math.floor(Date.now() / 1000);

    const inputs: CircuitInputs = {
      balance_1: balances[0].toString(),
      balance_2: balances[1].toString(),
      balance_3: balances[2].toString(),
      tier_lower_bound: tier.lowerBound.toString(),
      tier_upper_bound: tier.upperBound.toString(),
      nullifier: nullifier.toString(),
      timestamp: timestamp.toString(),
    };

    try {
      // Use snarkjs with in-memory buffers
      const { proof, publicSignals } = await groth16.fullProve(
        inputs as unknown as Record<string, string>,
        new Uint8Array(wasmBuffer),
        new Uint8Array(zkeyBuffer),
      );

      return {
        proof,
        publicSignals,
        tier: tier.tier,
        tierLabel: tier.label,
        timestamp,
      };
    } catch (error) {
      throw new Error(
        `Browser proof generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Estimate proof generation time based on circuit size
   * @returns Estimated time in seconds
   */
  static estimateProofTime(): { min: number; max: number } {
    // Based on typical performance for ~200-250 constraint circuits
    return { min: 5, max: 15 };
  }
}
