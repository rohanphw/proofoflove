# Proof of Love

A zero-knowledge proof system for verifying wealth tiers without revealing exact balances. Built with Circom, snarkjs, and multi-chain balance adapters. The idea is to build a dating app which uses your wealth as the deciding factor. It's a WIP, right now it only generates a ZK proof of your onchain wealth using manual selection of wallets without any verification, I will eventually complete this

## What It Does

**Problem:** Dating apps let you lie about everything.

**Solution:** Proof of Love uses zero-knowledge cryptography to verify your wealth tier — without revealing your exact balance, which wallets you own, or which chains your funds are on.

Connect your wallets, and the system computes your **average balance** across 3 monthly snapshots (90-day lookback), then generates a Groth16 proof that this average falls within a specific tier. A verifier can confirm the tier is legitimate without learning anything else.

Proofs can be verified **on-chain on Solana** — the program stores a TierBadge PDA as a portable, trustless credential that other apps can read.

## Tier System

All values are in USD, calculated as the average across 3 snapshots.

| Tier | Label | Range |
|------|-------|-------|
| 1 | 🌱 Seed | < $1K |
| 2 | 🌿 Sprout | $1K – $10K |
| 3 | 🌳 Tree | $10K – $50K |
| 4 | 🏔️ Mountain | $50K – $250K |
| 5 | 🌊 Ocean | $250K – $1M |
| 6 | 🌕 Moon | $1M – $5M |
| 7 | ☀️ Sun | $5M+ |

## Supported Chains

**Solana** — All SPL tokens discovered dynamically via Helius DAS

**Ethereum** — Native ETH + all ERC-20 tokens discovered via QuickNode Token API

**Arbitrum** — Native ETH + all ERC-20 tokens discovered via QuickNode Token API

**Base** — Native ETH + all ERC-20 tokens discovered via QuickNode Token API

**HyperEVM** — Native HYPE (public RPC, no API key needed)

No hardcoded token lists — the system automatically discovers your holdings and prices them via Pyth Hermes (live), DeFiLlama (live + historical), Jupiter Price API (Solana fallback), and Pyth TradingView (historical fallback).

## Project Structure

```
proofoflove/
├── packages/
│   ├── circuits/          # Circom ZK circuit + trusted setup scripts
│   ├── chain-adapters/    # Multi-chain balance fetchers
│   ├── core/              # Proof generation, verification SDK & Solana submitter
│   ├── verifier/          # Solana on-chain Groth16 verifier (Anchor program)
│   └── demo/              # CLI demo + browser demo (Vite)
└── README.md
```

## Prerequisites

- Node.js 20+
- pnpm 8+
- Circom compiler 2.1.6+ ([installation guide](https://docs.circom.io/getting-started/installation/))
- Rust + Solana CLI + Anchor 0.31.1+ (for on-chain verifier)

**API keys** (for whichever chains you want to query):

- [Helius](https://www.helius.dev/) — Solana RPC
- [QuickNode](https://www.quicknode.com/) or any archive RPC — Ethereum, Arbitrum, Base

HyperEVM uses a public RPC and doesn't need a key.

## Setup

```bash
# Clone and install
git clone https://github.com/rohanphw/proofoflove.git
cd proofoflove
pnpm install
```

### Compile the Circuit

```bash
cd packages/circuits
./scripts/compile.sh
./scripts/setup.sh
```

This generates:
- `build/wealth_tier_js/wealth_tier.wasm` — circuit WASM
- `build/keys/wealth_tier_final.zkey` — proving key
- `build/keys/verification_key.json` — verification key

### Configure Wallets (CLI Demo)

```bash
cd packages/demo/src
cp config.example.json config.json
```

Edit `config.json` with your API keys and wallet addresses.

## Running

### CLI Demo

```bash
pnpm demo:cli
```

### Web Demo (Browser)

The web demo runs proof generation entirely client-side — no backend needed.

```bash
# Copy circuit artifacts for static serving
pnpm run --filter @proofoflove/demo setup:circuits

# Launch dev server
pnpm run --filter @proofoflove/demo dev
```

Opens at `http://localhost:5173`. Enter your API keys and wallet addresses in the browser, and everything runs locally.

## On-Chain Verification (Solana)

The `packages/verifier` directory contains a Solana program (Anchor) that verifies Groth16 proofs on-chain using the native `alt_bn128` precompile and stores the result as a **TierBadge PDA**.

### How It Works

1. User generates a Groth16 proof off-chain (browser or CLI)
2. The proof is serialized and submitted to the Solana program via the `solana-submitter` helper
3. The program verifies the proof on-chain using `groth16-solana`
4. On success, a TierBadge PDA is created/updated with the verified tier, bounds, and a 30-day expiry

### TierBadge PDA

Each user gets one TierBadge account (derived from `["tier_badge", user_pubkey]`) containing:
- Verified tier number (1-7)
- Tier bounds (lower/upper in USD cents)
- Verification timestamp and 30-day expiry
- Nullifier to prevent duplicate proofs

### Build & Test the Verifier

```bash
cd packages/verifier
anchor build
anchor test
```

The test suite covers:
- Successful Groth16 proof verification and PDA creation
- Re-verification updating existing PDA timestamps
- Rejection of invalid tier bounds / mismatched proofs
- Rejection of premature badge revocation (before 30-day expiry)
- Multi-user isolation (separate PDAs per user)

### Solana Submitter

The `packages/core` directory includes `solana-submitter.ts`, a TypeScript helper that converts snarkjs proof output into the format expected by the Solana program:

- **proof_a** y-coordinate negation for Solana's pairing check
- **proof_b** G2 point c0/c1 swap for `groth16-solana` compatibility
- Public signals encoded as 32-byte big-endian buffers

Three usage modes:
- `submitProofToSolana()` — full send with a Keypair
- `prepareVerifyTransaction()` — returns a Transaction for wallet adapters
- `buildVerifyInstruction()` — raw instruction builder for custom flows

## How It Works

### Circuit

The Circom circuit proves that `MIN(balance_1, balance_2, balance_3)` falls within a tier's bounds.

**Private inputs:** `balance_1`, `balance_2`, `balance_3` — aggregated USD totals in cents across all wallets and chains.

**Public inputs:** `tier_lower_bound`, `tier_upper_bound`, `nullifier`, `timestamp`

The circuit computes the minimum across 3 snapshots (preventing flash-loan attacks — you must maintain the balance for 90 days), then range-checks it against the tier bounds.

### Chain Adapters

Each adapter fetches historical balances at 3 snapshot dates (today, 45 days ago, 90 days ago). The aggregator sums across all wallets and chains per snapshot, producing 3 total balance figures in USD cents.

Price lookups use a module-level cache shared across all EVM chains — ETH price is fetched once and reused for Ethereum, Arbitrum, and Base.

### Proof Generation

1. Fetch historical balances across all wallets/chains
2. Compute Poseidon nullifier from wallet addresses + user secret
3. Determine tier from minimum balance
4. Generate Groth16 proof via snarkjs
5. Verify proof against verification key

The nullifier prevents the same wallet set from generating proofs for multiple accounts.

## Testing

```bash
# Circuit tests (20 test cases including boundary conditions)
cd packages/circuits && npm test

# Chain adapter tests
cd packages/chain-adapters && npm test

# Core SDK tests
cd packages/core && npm test

# Solana on-chain verifier (5 tests, requires local validator)
cd packages/verifier && anchor test
```