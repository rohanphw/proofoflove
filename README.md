# Proof of Love — ZK Wealth Verification

A zero-knowledge proof system for verifying cryptocurrency wealth tiers without revealing exact balances. Built with Circom, snarkjs, and multi-chain balance adapters.

## What It Does

**Problem:** Dating apps let you lie about everything.

**Solution:** Proof of Love uses zero-knowledge cryptography to verify your wealth tier — without revealing your exact balance, which wallets you own, or which chains your funds are on.

Connect your wallets, and the system computes your **average balance** across 3 monthly snapshots (90-day lookback), then generates a Groth16 proof that this average falls within a specific tier. A verifier can confirm the tier is legitimate without learning anything else.

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

## Supported Chains & Tokens

**Solana** — SOL, USDC, USDT, hSOL

**Ethereum** — ETH, USDC, USDT, WBTC

**Arbitrum** — ETH, USDC, USDC.e, USDT, WBTC

**Base** — ETH, USDC, USDbC

**HyperEVM** — HYPE (public RPC, no API key needed)

Prices are fetched via Pyth Hermes (live) and CoinGecko → Pyth TradingView

## Project Structure

```
proofoflove/
├── packages/
│   ├── circuits/          # Circom ZK circuit + trusted setup scripts
│   ├── chain-adapters/    # Multi-chain balance fetchers
│   ├── core/              # Proof generation & verification SDK
│   └── demo/              # CLI demo + browser demo (Vite)
└── README.md
```

## Prerequisites

- Node.js 20+
- pnpm 8+
- Circom compiler 2.1.6+ ([installation guide](https://docs.circom.io/getting-started/installation/))

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

## How It Works

### Circuit

The Circom circuit (215 constraints) proves that `AVG(balance_1, balance_2, balance_3)` falls within a tier's bounds.

**Private inputs:** `balance_1`, `balance_2`, `balance_3` — aggregated USD totals in cents across all wallets and chains.

**Public inputs:** `tier_lower_bound`, `tier_upper_bound`, `nullifier`, `timestamp`

The circuit computes the average using integer division with remainder verification, then range-checks it against the tier bounds.

### Chain Adapters

Each adapter fetches historical balances at 3 snapshot dates (today, 45 days ago, 90 days ago). The aggregator sums across all wallets and chains per snapshot, producing 3 total balance figures in USD cents.

Price lookups use a module-level cache shared across all EVM chains — ETH price is fetched once and reused for Ethereum, Arbitrum, and Base.

### Proof Generation

1. Fetch historical balances across all wallets/chains
2. Compute Poseidon nullifier from wallet addresses + user secret
3. Determine tier from average balance
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
```