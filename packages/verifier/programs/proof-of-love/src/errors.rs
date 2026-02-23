use anchor_lang::prelude::*;

#[error_code]
pub enum ProofOfLoveError {
    #[msg("Groth16 proof verification failed")]
    ProofVerificationFailed,

    #[msg("Invalid tier: bounds do not match any known tier")]
    InvalidTier,

    #[msg("Proof timestamp is too old (must be within 10 minutes)")]
    ProofTooOld,

    #[msg("Nullifier already used by another account")]
    NullifierAlreadyUsed,

    #[msg("Tier badge has not expired yet")]
    BadgeNotExpired,
}