use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

pub mod errors;
pub mod state;
pub mod verifying_key;

use errors::ProofOfLoveError;
use state::TierBadge;
use verifying_key::{NR_PUBLIC_INPUTS, VERIFYING_KEY};

declare_id!("BBDtJxqUFWpCXMvZjtCFQyYGJ698o84H3RpqcJQjnGLR");

/// 30 days in seconds
const BADGE_VALIDITY_SECONDS: i64 = 30 * 24 * 60 * 60;

/// 10 minutes in seconds — max age for a proof timestamp
const MAX_PROOF_AGE_SECONDS: i64 = 10 * 60;

#[program]
pub mod proof_of_love {
    use super::*;

    /// Verify a Groth16 proof of wealth tier and store the result as a PDA.
    ///
    /// The proof is generated client-side from a Circom WealthTier circuit.
    /// Public signals: [tier_lower_bound, tier_upper_bound, nullifier, timestamp]
    ///
    /// proof_a must already have its y-coordinate negated before submission.
    pub fn verify_and_store_tier(
        ctx: Context<VerifyAndStoreTier>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS],
    ) -> Result<()> {
        // 1. Verify the Groth16 proof on-chain
        let mut verifier = Groth16Verifier::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &VERIFYING_KEY,
        )
        .map_err(|_| ProofOfLoveError::ProofVerificationFailed)?;

        verifier
            .verify()
            .map_err(|_| ProofOfLoveError::ProofVerificationFailed)?;

        // 2. Decode public signals
        let tier_lower = u64::from_be_bytes(public_inputs[0][24..32].try_into().unwrap());
        let tier_upper = u64::from_be_bytes(public_inputs[1][24..32].try_into().unwrap());
        let nullifier = public_inputs[2];
        let timestamp = i64::from_be_bytes(public_inputs[3][24..32].try_into().unwrap());

        // 3. Validate tier bounds match a known tier
        let tier = match (tier_lower, tier_upper) {
            (0, 100_000) => 1,                     // Seed: < $1K
            (100_000, 1_000_000) => 2,              // Sprout: $1K - $10K
            (1_000_000, 5_000_000) => 3,            // Tree: $10K - $50K
            (5_000_000, 25_000_000) => 4,           // Mountain: $50K - $250K
            (25_000_000, 100_000_000) => 5,         // Ocean: $250K - $1M
            (100_000_000, 500_000_000) => 6,        // Moon: $1M - $5M
            (500_000_000, 10_000_000_000_000) => 7, // Sun: $5M+
            _ => return Err(ProofOfLoveError::InvalidTier.into()),
        };

        // 4. Validate proof freshness
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(
            now - timestamp <= MAX_PROOF_AGE_SECONDS,
            ProofOfLoveError::ProofTooOld
        );

        // 5. Write the TierBadge PDA
        let badge = &mut ctx.accounts.tier_badge;
        badge.owner = ctx.accounts.user.key();
        badge.tier = tier;
        badge.tier_lower_bound = tier_lower;
        badge.tier_upper_bound = tier_upper;
        badge.nullifier = nullifier;
        badge.verified_at = timestamp;
        badge.expires_at = timestamp + BADGE_VALIDITY_SECONDS;
        badge.bump = ctx.bumps.tier_badge;

        msg!(
            "Proof of Love: {} verified as Tier {} (bounds: {} - {})",
            ctx.accounts.user.key(),
            tier,
            tier_lower,
            tier_upper
        );

        Ok(())
    }

    /// Revoke an expired tier badge, reclaiming the rent.
    pub fn revoke_expired_tier(ctx: Context<RevokeExpiredTier>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > ctx.accounts.tier_badge.expires_at,
            ProofOfLoveError::BadgeNotExpired
        );

        msg!(
            "Proof of Love: Tier badge revoked for {}",
            ctx.accounts.tier_badge.owner
        );

        Ok(())
    }
}

#[derive(Accounts)]
pub struct VerifyAndStoreTier<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + TierBadge::INIT_SPACE,
        seeds = [b"tier_badge", user.key().as_ref()],
        bump,
    )]
    pub tier_badge: Account<'info, TierBadge>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeExpiredTier<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [b"tier_badge", tier_badge.owner.as_ref()],
        bump = tier_badge.bump,
        constraint = tier_badge.owner == user.key(),
    )]
    pub tier_badge: Account<'info, TierBadge>,
}