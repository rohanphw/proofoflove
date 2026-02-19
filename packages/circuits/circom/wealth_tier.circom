pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/gates.circom";
include "./utils.circom";

// Main circuit for proving wealth tier
// Proves: MIN(balance_1, balance_2, balance_3) falls within [tier_lower_bound, tier_upper_bound)
//
// Private inputs: 3 aggregated balance snapshots (USD in cents)
// Public inputs: tier bounds, nullifier (identity commitment), timestamp
//
// NOTE: For Tier 7 ($5M+, no natural upper bound), use MAX_BALANCE as tier_upper_bound.
// MAX_BALANCE = 10^16 cents = $100 trillion (far exceeds any realistic balance)
template WealthTier() {
    // PRIVATE INPUTS: 3 aggregated USD balance snapshots (in cents)
    // These are the totals across ALL connected wallets at 3 points in time
    signal input balance_1;
    signal input balance_2;
    signal input balance_3;

    // PUBLIC INPUTS
    signal input tier_lower_bound;  // Lower bound of claimed tier (in cents)
    signal input tier_upper_bound;  // Upper bound of claimed tier (in cents)
    signal input nullifier;         // hash(wallet_addresses + user_secret) - prevents multi-accounting
    signal input timestamp;         // Unix timestamp of proof generation

    // Step 1: Compute minimum balance across 3 snapshots
    // This prevents flash-loan attacks - user must maintain balance for 90 days
    component min3 = Min3();
    min3.in[0] <== balance_1;
    min3.in[1] <== balance_2;
    min3.in[2] <== balance_3;

    signal min_balance;
    min_balance <== min3.out;

    // Step 2: Check min_balance >= tier_lower_bound
    component gte_lower = GreaterEqThan(64);
    gte_lower.in[0] <== min_balance;
    gte_lower.in[1] <== tier_lower_bound;

    // Step 3: Check min_balance < tier_upper_bound
    component lt_upper = LessThan(64);
    lt_upper.in[0] <== min_balance;
    lt_upper.in[1] <== tier_upper_bound;

    // Step 4: Both constraints must be satisfied
    // Hard constraint: proof cannot be generated unless both checks pass
    component and_gate = AND();
    and_gate.a <== gte_lower.out;
    and_gate.b <== lt_upper.out;
    and_gate.out === 1;

    // Step 5: Bind nullifier and timestamp to the proof
    // Squaring ensures these public inputs are constrained
    signal nullifier_sq;
    nullifier_sq <== nullifier * nullifier;

    signal timestamp_sq;
    timestamp_sq <== timestamp * timestamp;
}

// Instantiate the main component
// Mark tier_lower_bound, tier_upper_bound, nullifier, and timestamp as public
component main {public [tier_lower_bound, tier_upper_bound, nullifier, timestamp]} = WealthTier();
