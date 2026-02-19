# Proof of Love - ZK Wealth Verification MVP

A Zero-Knowledge Proof system for verifying cryptocurrency wealth tiers without revealing exact balances. Built with Circom, snarkjs, and multi-chain balance adapters.

## Overview

**Problem:** Dating apps let you lie about everything. Proof of Love uses cryptography to verify at least one thing is real - your wealth tier.

**Solution:** Connect your crypto wallets, generate a zero-knowledge proof that your average balance over 90 days falls within a specific tier (e.g., $50K-$250K), without revealing:
- Your exact balance
- Which wallets you own
- Which blockchains your funds are on

## Features

- **Zero-Knowledge Proofs** using Groth16 (via Circom + snarkjs)
- **Multi-Chain Support**: Solana + Ethereum (extensible to more chains)
- **Multi-Wallet Aggregation**: Connect as many wallets as you want
- **Volatility Smoothing**: Uses average balance across 3 monthly snapshots (90-day lookback) — a temporary dip won't tank your tier
- **7 Wealth Tiers**: From Seed (<$1K) to Sun ($5M+)
- **Privacy-Preserving**: Backend never sees your actual balances

## Project Structure
```
proofoflove/
├── packages/
│   ├── circuits/          # Circom ZK circuit + trusted setup
│   ├── chain-adapters/    # Multi-chain balance fetchers (Solana, Ethereum)
│   ├── core/              # Proof generation & verification SDK
│   └── demo/              # CLI demo for testing
├── spec.md                # Product specification
└── README.md              # This file
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 8+
- Circom compiler 2.1.6+
- Rust (for Circom compilation)
- API Keys:
  - [Helius](https://www.helius.dev/) (Solana RPC)
  - [Alchemy](https://www.alchemy.com/) (Ethereum RPC)

### Installation
```bash
# 1. Clone and install dependencies
git clone <repo-url>
cd proofoflove
pnpm install

# 2. Install Circom compiler
# See: https://docs.circom.io/getting-started/installation/
# Quick install (Linux/Mac):
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
cargo install --path circom

# 3. Compile circuit and run trusted setup
cd packages/circuits
./scripts/compile.sh
./scripts/setup.sh

# This generates:
#   - build/wealth_tier_js/wealth_tier.wasm
#   - build/keys/wealth_tier_final.zkey
#   - build/keys/verification_key.json
```

### Running the Demo
```bash
# 1. Configure API keys and test wallets
cd packages/demo/src
cp config.example.json config.json
# Edit config.json with your API keys and wallet addresses

# 2. Run the CLI demo
cd ../../..
pnpm run demo:cli
```

**Expected output:**
```
========================================
Proof of Love - ZK Wealth Verification
========================================

Initializing chain adapters...
✓ Registered chains: solana, ethereum

Connected wallets:
  1. solana: 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
  2. ethereum: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb

Fetching historical balances...

Total aggregated balances:
  Snapshot 1: $125,432.18
  Snapshot 2: $118,250.00
  Snapshot 3: $121,890.45

Average balance: $121,857.54

Generating zero-knowledge proof...

✅ Proof generated successfully!
   Tier: 🏔️ Mountain
   Timestamp: 2026-02-18T19:30:00Z

Verifying proof...
✅ Proof is VALID
   Verified tier: 🏔️ Mountain

Demo complete! 🎉
```

## Architecture

### 1. Circuit (`packages/circuits`)

The Circom circuit proves: `AVG(balance_1, balance_2, balance_3)` falls within a tier range WITHOUT revealing balances. Integer division is proven via `sum === avg * 3 + remainder` with `remainder ∈ {0, 1, 2}`.

**Private inputs:**
- `balance_1`, `balance_2`, `balance_3` - Aggregated USD totals (in cents)

**Public inputs:**
- `tier_lower_bound`, `tier_upper_bound` - Tier boundaries
- `nullifier` - Identity commitment (prevents multi-accounting)
- `timestamp` - Proof generation time

**Constraints:**
```
avg_balance = AVG(balance_1, balance_2, balance_3)
valid = (avg_balance >= tier_lower_bound) AND (avg_balance < tier_upper_bound)
```

### 2. Chain Adapters (`packages/chain-adapters`)

Fetches historical balances from different blockchains.

**Solana Adapter:**
- Uses Helius archive RPC
- Fetches SOL + SPL token balances at 3 historical slots
- Converts to USD using Pyth price feeds

**Ethereum Adapter:**
- Uses Alchemy archive node
- Fetches ETH + ERC-20 balances at 3 historical blocks
- Converts to USD using CoinGecko API

**Aggregator:**
- Sums balances across all wallets and chains
- Returns 3 total snapshots for circuit input

### 3. Core SDK (`packages/core`)

**Prover:**
- Wraps snarkjs `groth16.fullProve()`
- Determines tier from average balance
- Generates proof (~5-15 seconds)

**Verifier:**
- Wraps snarkjs `groth16.verify()`
- Validates proof against verification key
- Extracts tier and validates public signal bounds match tier definition

**Nullifier:**
- Uses Poseidon hash: `hash(wallet_addresses + user_secret)`
- Prevents same wallet set from being used in multiple accounts

### 4. Tier System

| Tier | Range | Badge |
|------|-------|-------|
| 1 | < $1K | 🌱 Seed |
| 2 | $1K – $10K | 🌿 Sprout |
| 3 | $10K – $50K | 🌳 Tree |
| 4 | $50K – $250K | 🏔️ Mountain |
| 5 | $250K – $1M | 🌊 Ocean |
| 6 | $1M – $5M | 🌕 Moon |
| 7 | $5M+ | ☀️ Sun |

## Testing
```bash
# Test circuit
cd packages/circuits
npm test

# Test chain adapters
cd packages/chain-adapters
npm test

# Test core SDK
cd packages/core
npm test
```

## Known Limitations (MVP)

### Accepted for MVP:

1. **Client-Side Aggregation**: Balance aggregation happens in JavaScript before entering the circuit. A sophisticated user could lie about inputs. ✅ ACCEPTED (production needs light client proofs)

2. **Development Trusted Setup**: Single-party setup means we could theoretically forge proofs. ✅ ACCEPTED (production needs MPC ceremony)

3. **Limited Token Support**: Only major tokens (SOL, ETH, USDC, USDT, WBTC). Unknown tokens valued at $0. ✅ ACCEPTABLE

4. **Historical Price Approximation**: Using external APIs (Pyth, CoinGecko) for prices. ✅ ACCEPTABLE

### Performance:
- Circuit compilation: ~2-5 minutes (one-time)
- Trusted setup: ~5-10 minutes (one-time)
- Balance fetching: ~30-60 seconds
- Proof generation: ~5-15 seconds
- Proof verification: <100ms

## Next Steps

After validating the circuit MVP:

1. **Desktop Web App** (Next.js)
   - Wallet connection UI (Solana Wallet Adapter + wagmi)
   - Balance fetching progress UI
   - Browser-based proof generation

2. **Backend API** (Node.js + PostgreSQL)
   - POST /api/verify-proof endpoint
   - Store verified tiers
   - User profiles + auth

3. **Mobile App** (PWA)
   - Profile feed with blurred photos + tier badges
   - Swipe mechanic
   - Chat with progressive unblur

4. **Production Hardening:**
   - Multi-party trusted setup ceremony
   - On-chain balance proof (Merkle proofs)
   - Security audit

## Resources

- [Circom Documentation](https://docs.circom.io/)
- [snarkjs GitHub](https://github.com/iden3/snarkjs)
- [Anon Aadhaar Reference](https://github.com/anon-aadhaar/anon-aadhaar)
- [Helius RPC Docs](https://www.helius.dev/docs)
- [Alchemy Docs](https://docs.alchemy.com/)
