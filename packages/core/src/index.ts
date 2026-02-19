// Export core functionality
export { WealthProver } from './prover.js';
export { WealthVerifier } from './verifier.js';
export { generateNullifier, isValidNullifier } from './nullifier.js';
export {
  TIERS,
  getTierForBalance,
  getTierByNumber,
  formatBalance,
  getTierBadge,
  type TierConfig
} from './tiers.js';

// Export types
export type {
  CircuitInputs,
  ProofData,
  VerificationResult
} from './types.js';
