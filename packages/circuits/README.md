# Circuits Package

Circom circuits for zero-knowledge wealth tier proofs.

## Overview

This package contains the core ZK circuit that proves `MIN(balance_1, balance_2, balance_3)` falls within a specific tier range, without revealing the actual balance values.

## Circuit Design

### Inputs

**Private Inputs:**
- `balance_1`: Total USD balance (in cents) at snapshot 1
- `balance_2`: Total USD balance (in cents) at snapshot 2
- `balance_3`: Total USD balance (in cents) at snapshot 3

**Public Inputs:**
- `tier_lower_bound`: Lower bound of claimed tier (in cents)
- `tier_upper_bound`: Upper bound of claimed tier (in cents)
- `nullifier`: Hash of wallet addresses + user secret
- `timestamp`: Unix timestamp of proof generation

**Public Output:**
- `valid`: 1 if proof valid, 0 otherwise

### Logic

```circom
min_balance = MIN(balance_1, balance_2, balance_3)
valid = (min_balance >= tier_lower_bound) AND (min_balance < tier_upper_bound)
```

## Files

- `circom/wealth_tier.circom` - Main circuit
- `circom/utils.circom` - Helper templates (Min3)
- `scripts/compile.sh` - Compile circuit to R1CS + WASM
- `scripts/setup.sh` - Run trusted setup (Groth16)
- `tests/wealth_tier.test.js` - Circuit tests

## Usage

### Compile Circuit

```bash
./scripts/compile.sh
```

This generates:
- `build/wealth_tier.r1cs` - Constraint system
- `build/wealth_tier_js/wealth_tier.wasm` - Witness generator
- `build/wealth_tier.sym` - Symbols file

### Run Trusted Setup

```bash
./scripts/setup.sh
```

This generates:
- `build/keys/wealth_tier_final.zkey` - Proving key (~5-10MB)
- `build/keys/verification_key.json` - Verification key

### Run Tests

```bash
npm test
```

## Constraint Count

Expected: ~150-200 constraints

The circuit is intentionally simple to keep proof generation fast (<15 seconds).

## Security Notes

**Development Setup:**
- The current setup uses a single-party trusted setup
- This is acceptable for MVP testing but NOT for production
- For production, run a multi-party computation (MPC) ceremony

**Known Limitation:**
- The circuit only validates tier claims against provided balances
- It does NOT verify that balances came from real blockchain data
- For production, add light client proofs or Merkle proofs

## References

- [Circom Language](https://docs.circom.io/circom-language/signals/)
- [circomlib](https://github.com/iden3/circomlib)
- [Groth16 Trusted Setup](https://docs.circom.io/getting-started/proving-circuits/)
