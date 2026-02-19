/**
 * Circuit inputs for wealth tier proof
 */
export interface CircuitInputs {
  // Private inputs (never revealed)
  balance_1: string;
  balance_2: string;
  balance_3: string;

  // Public inputs (visible to verifier)
  tier_lower_bound: string;
  tier_upper_bound: string;
  nullifier: string;
  timestamp: string;
}

/**
 * Generated proof data
 */
export interface ProofData {
  /** Groth16 proof object */
  proof: any;
  /** Public signals from the circuit */
  publicSignals: string[];
  /** Tier number (1-7) */
  tier: number;
  /** Tier label (e.g., "Mountain") */
  tierLabel: string;
  /** Timestamp when proof was generated */
  timestamp: number;
}

/**
 * Verification result
 */
export interface VerificationResult {
  /** Whether the proof is valid */
  valid: boolean;
  /** Tier number (if valid) */
  tier?: number;
  /** Tier label (if valid) */
  tierLabel?: string;
  /** Nullifier (identity commitment) */
  nullifier?: string;
  /** Timestamp of proof generation */
  timestamp?: number;
  /** Error message (if invalid) */
  error?: string;
}
