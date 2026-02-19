/**
 * Tier configuration
 */
export interface TierConfig {
  tier: number;
  label: string;
  emoji: string;
  lowerBound: number;  // USD in cents
  upperBound: number;  // USD in cents
}

/**
 * MAX_BALANCE constant for Tier 7 (top tier, no natural upper bound)
 * 10^16 cents = $100 trillion (far exceeds any realistic balance)
 * Used as tier_upper_bound in the circuit for Tier 7
 */
export const MAX_BALANCE = 10_000_000_000_000_000; // 10^16 cents

/**
 * Tier definitions from Seed ($0-$1K) to Sun ($5M+)
 * These represent minimum balance thresholds across 3 monthly snapshots
 */
export const TIERS: TierConfig[] = [
  {
    tier: 1,
    label: 'Seed',
    emoji: '🌱',
    lowerBound: 0,
    upperBound: 100_000  // $1,000
  },
  {
    tier: 2,
    label: 'Sprout',
    emoji: '🌿',
    lowerBound: 100_000,    // $1,000
    upperBound: 1_000_000   // $10,000
  },
  {
    tier: 3,
    label: 'Tree',
    emoji: '🌳',
    lowerBound: 1_000_000,   // $10,000
    upperBound: 5_000_000    // $50,000
  },
  {
    tier: 4,
    label: 'Mountain',
    emoji: '🏔️',
    lowerBound: 5_000_000,   // $50,000
    upperBound: 25_000_000   // $250,000
  },
  {
    tier: 5,
    label: 'Ocean',
    emoji: '🌊',
    lowerBound: 25_000_000,   // $250,000
    upperBound: 100_000_000   // $1,000,000
  },
  {
    tier: 6,
    label: 'Moon',
    emoji: '🌕',
    lowerBound: 100_000_000,  // $1,000,000
    upperBound: 500_000_000   // $5,000,000
  },
  {
    tier: 7,
    label: 'Sun',
    emoji: '☀️',
    lowerBound: 500_000_000,  // $5,000,000
    upperBound: MAX_BALANCE   // $100 trillion (practical infinity)
  }
];

/**
 * Get tier for a given balance (minimum across 3 snapshots)
 * @param minBalanceCents - Minimum balance in USD cents
 * @returns TierConfig for the appropriate tier
 */
export function getTierForBalance(minBalanceCents: number): TierConfig {
  for (const tier of TIERS) {
    if (minBalanceCents >= tier.lowerBound && minBalanceCents < tier.upperBound) {
      return tier;
    }
  }
  // Fallback to Tier 1 if no match (shouldn't happen)
  return TIERS[0];
}

/**
 * Get tier by tier number (1-7)
 * @param tierNumber - Tier number
 * @returns TierConfig or undefined if not found
 */
export function getTierByNumber(tierNumber: number): TierConfig | undefined {
  return TIERS.find(t => t.tier === tierNumber);
}

/**
 * Format balance as human-readable string
 * @param balanceCents - Balance in cents
 * @returns Formatted string (e.g., "$125,432.18")
 */
export function formatBalance(balanceCents: number): string {
  const dollars = balanceCents / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(dollars);
}

/**
 * Get tier badge display (emoji + label)
 * @param tier - Tier number or TierConfig
 * @returns Display string (e.g., "🏔️ Mountain")
 */
export function getTierBadge(tier: number | TierConfig): string {
  const config = typeof tier === 'number' ? getTierByNumber(tier) : tier;
  if (!config) return '❓ Unknown';
  return `${config.emoji} ${config.label}`;
}
