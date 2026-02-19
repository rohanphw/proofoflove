import { groth16 } from "snarkjs";
import { TIERS, getTierByNumber } from "./tiers.js";
import type { ProofData, VerificationResult } from "./types.js";

/**
 * Wealth tier proof verifier
 * Wraps snarkjs for proof verification
 */
export class WealthVerifier {
  private vkey: any;

  /**
   * Create a verifier instance
   * @param verificationKey - Verification key JSON object
   */
  constructor(verificationKey: any) {
    this.vkey = verificationKey;
  }

  /**
   * Verify a proof
   * @param proofData - Proof data to verify
   * @returns VerificationResult with validity and extracted data
   */
  async verify(proofData: ProofData): Promise<VerificationResult> {
    try {
      // Verify the proof using snarkjs
      const isValid = await groth16.verify(
        this.vkey,
        proofData.publicSignals,
        proofData.proof,
      );

      if (!isValid) {
        return {
          valid: false,
          error: "Invalid proof: verification failed",
        };
      }

      // Extract public signals
      // Order: [tier_lower_bound, tier_upper_bound, nullifier, timestamp]
      const [tierLower, tierUpper, nullifier, timestamp] =
        proofData.publicSignals.map(BigInt);

      // Validate that the public signal bounds match a known tier definition
      const claimedTier = getTierByNumber(proofData.tier);
      if (!claimedTier) {
        return {
          valid: false,
          error: `Unknown tier number: ${proofData.tier}`,
        };
      }

      if (
        BigInt(claimedTier.lowerBound) !== tierLower ||
        BigInt(claimedTier.upperBound) !== tierUpper
      ) {
        return {
          valid: false,
          error: `Tier bounds mismatch: proof has [${tierLower}, ${tierUpper}), tier ${proofData.tier} expects [${claimedTier.lowerBound}, ${claimedTier.upperBound})`,
        };
      }

      return {
        valid: true,
        tier: proofData.tier,
        tierLabel: proofData.tierLabel,
        nullifier: nullifier.toString(),
        timestamp: Number(timestamp),
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Verification failed",
      };
    }
  }

  /**
   * Batch verify multiple proofs
   * @param proofs - Array of proof data to verify
   * @returns Array of verification results
   */
  async verifyBatch(proofs: ProofData[]): Promise<VerificationResult[]> {
    return Promise.all(proofs.map((proof) => this.verify(proof)));
  }

  /**
   * Load verification key from JSON file (Node.js)
   * @param vkeyPath - Path to verification_key.json
   * @returns WealthVerifier instance
   */
  static async loadFromFile(vkeyPath: string): Promise<WealthVerifier> {
    const fs = await import("fs/promises");
    const vkey = JSON.parse(await fs.readFile(vkeyPath, "utf-8"));
    return new WealthVerifier(vkey);
  }

  /**
   * Load verification key from URL (browser)
   * @param vkeyUrl - URL to verification_key.json
   * @returns WealthVerifier instance
   */
  static async loadFromUrl(vkeyUrl: string): Promise<WealthVerifier> {
    const response = await fetch(vkeyUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to load verification key: ${response.statusText}`,
      );
    }
    const vkey = await response.json();
    return new WealthVerifier(vkey);
  }
}
