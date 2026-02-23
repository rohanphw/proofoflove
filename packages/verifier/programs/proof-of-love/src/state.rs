use anchor_lang::prelude::*;

/// PDA that stores a user's verified wealth tier.
/// Seeds: [b"tier_badge", user_pubkey]
#[account]
#[derive(InitSpace)]
pub struct TierBadge {
    /// The wallet that owns this tier badge
    pub owner: Pubkey,

    /// Verified tier (1-7: Seed, Sprout, Tree, Mountain, Ocean, Moon, Sun)
    pub tier: u8,

    /// Lower bound of the tier range in USD cents
    pub tier_lower_bound: u64,

    /// Upper bound of the tier range in USD cents
    pub tier_upper_bound: u64,

    /// Poseidon nullifier hash — prevents multi-account abuse
    pub nullifier: [u8; 32],

    /// Unix timestamp when the proof was generated
    pub verified_at: i64,

    /// Unix timestamp when this badge expires (verified_at + 30 days)
    pub expires_at: i64,

    /// Bump seed for PDA derivation
    pub bump: u8,
}