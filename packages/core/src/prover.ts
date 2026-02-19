import { groth16 } from 'snarkjs';
import { getTierForBalance } from './tiers.js';
import type { ProofData, CircuitInputs } from './types.js';

/**
 * Wealth tier proof generator
 * Wraps snarkjs for browser and Node.js proof generation
 */
export class WealthProver {
  private wasmPath?: string;
  private zkeyPath?: string;

  /**
   * Create a prover instance
   * @param artifactsPath - Path to circuit artifacts directory (for Node.js)
   */
  constructor(artifactsPath?: string) {
    if (artifactsPath) {
      this.wasmPath = `${artifactsPath}/wealth_tier.wasm`;
      this.zkeyPath = `${artifactsPath}/wealth_tier_final.zkey`;
    }
  }

  /**
   * Generate proof of wealth tier (Node.js version)
   * @param balances - 3 aggregated balance snapshots in USD cents
   * @param nullifier - Identity commitment (from generateNullifier)
   * @param timestamp - Unix timestamp (defaults to now)
   * @returns ProofData with proof, public signals, and tier info
   */
  async generateProof(
    balances: [number, number, number],
    nullifier: bigint,
    timestamp: number = Math.floor(Date.now() / 1000)
  ): Promise<ProofData> {
    if (!this.wasmPath || !this.zkeyPath) {
      throw new Error('Prover not initialized with artifact paths. Use generateProofBrowser() instead.');
    }

    // Determine tier from minimum balance
    const minBalance = Math.min(...balances);
    const tier = getTierForBalance(minBalance);

    console.log(`Generating proof for Tier ${tier.tier} (${tier.label})`);
    console.log(`Min balance: ${(minBalance / 100).toFixed(2)} USD`);

    // Prepare circuit inputs
    const inputs: CircuitInputs = {
      balance_1: balances[0].toString(),
      balance_2: balances[1].toString(),
      balance_3: balances[2].toString(),
      tier_lower_bound: tier.lowerBound.toString(),
      tier_upper_bound: tier.upperBound.toString(),
      nullifier: nullifier.toString(),
      timestamp: timestamp.toString()
    };

    console.log('Generating witness and proof (this may take 5-15 seconds)...');

    try {
      // Generate proof using snarkjs
      const { proof, publicSignals } = await groth16.fullProve(
        inputs,
        this.wasmPath,
        this.zkeyPath
      );

      console.log('✓ Proof generated successfully!');

      return {
        proof,
        publicSignals,
        tier: tier.tier,
        tierLabel: tier.label,
        timestamp
      };
    } catch (error) {
      console.error('✗ Proof generation failed:', error);
      throw new Error(`Proof generation failed: ${error instanceof Error ? error.message : String(error)}`);
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
    zkeyBuffer: ArrayBuffer
  ): Promise<ProofData> {
    const minBalance = Math.min(...balances);
    const tier = getTierForBalance(minBalance);
    const timestamp = Math.floor(Date.now() / 1000);

    const inputs: CircuitInputs = {
      balance_1: balances[0].toString(),
      balance_2: balances[1].toString(),
      balance_3: balances[2].toString(),
      tier_lower_bound: tier.lowerBound.toString(),
      tier_upper_bound: tier.upperBound.toString(),
      nullifier: nullifier.toString(),
      timestamp: timestamp.toString()
    };

    try {
      // Use snarkjs with in-memory buffers
      const { proof, publicSignals } = await groth16.fullProve(
        inputs,
        new Uint8Array(wasmBuffer),
        new Uint8Array(zkeyBuffer)
      );

      return {
        proof,
        publicSignals,
        tier: tier.tier,
        tierLabel: tier.label,
        timestamp
      };
    } catch (error) {
      throw new Error(`Browser proof generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Estimate proof generation time based on circuit size
   * @returns Estimated time in seconds
   */
  static estimateProofTime(): { min: number; max: number } {
    // Based on typical performance for ~150-200 constraint circuits
    return { min: 5, max: 15 };
  }
}
