# Demo Package

CLI demo for testing the end-to-end ZK wealth verification flow.

## Setup

### 1. Configure API Keys

```bash
cd packages/demo/src
cp config.example.json config.json
```

Edit `config.json` with your API keys and wallet addresses:

```json
{
  "heliusApiKey": "your-helius-api-key",
  "alchemyApiKey": "your-alchemy-api-key",
  "testWallets": {
    "solana": ["your-solana-address"],
    "ethereum": ["your-ethereum-address"]
  },
  "userSecret": "any-secret-phrase"
}
```

**Get API Keys:**
- Helius: [helius.dev](https://www.helius.dev/)
- Alchemy: [alchemy.com](https://www.alchemy.com/)

### 2. Compile Circuit

```bash
cd ../../circuits
./scripts/compile.sh
./scripts/setup.sh
cd ../demo
```

### 3. Build TypeScript

```bash
cd ../..  # Back to root
pnpm run build
```

## Running the Demo

```bash
pnpm run demo:cli
```

## What It Does

The CLI demo demonstrates the complete flow:

1. **Initialize Adapters**: Register Solana and Ethereum adapters
2. **Load Wallets**: Read wallet addresses from config
3. **Generate Snapshots**: Create 3 time points (~now, ~30d ago, ~60d ago)
4. **Fetch Balances**: Query historical balances from blockchain RPCs
5. **Aggregate**: Sum balances across all wallets and chains
6. **Generate Nullifier**: Hash wallet addresses + user secret
7. **Generate Proof**: Create ZK proof of tier (5-15 seconds)
8. **Save Proof**: Write to `examples/test_proof.json`
9. **Verify Proof**: Cryptographically validate the proof

## Expected Output

```
========================================
Proof of Love - ZK Wealth Verification
========================================

Initializing chain adapters...
✓ Registered chains: solana, ethereum

Connected wallets:
  1. solana: 9WzDXwBb...
  2. ethereum: 0x742d35...

Fetching historical balances...
  [1/2] Fetching solana wallet: 9WzDXwBb...
    ✓ solana balance: $50,123.45, $48,900.12, $49,500.78
  [2/2] Fetching ethereum wallet: 0x742d35...
    ✓ ethereum balance: $75,308.73, $69,349.88, $72,389.67

Total aggregated balances:
  Snapshot 1: $125,432.18
  Snapshot 2: $118,250.00
  Snapshot 3: $121,890.45

Minimum balance: $118,250.00

Generating zero-knowledge proof...
(This may take 5-15 seconds)

✅ Proof generated successfully!
   Tier: 🏔️ Mountain
   Timestamp: 2026-02-18T19:30:00Z

💾 Proof saved to: examples/test_proof.json

Verifying proof...
✅ Proof is VALID
   Verified tier: 🏔️ Mountain
   Nullifier: 1234567890123456...
   Timestamp: 2026-02-18T19:30:00Z

========================================
Demo complete! 🎉
========================================

What just happened:
1. ✓ Fetched real blockchain balances from Solana + Ethereum
2. ✓ Aggregated balances across all wallets at 3 time points
3. ✓ Generated ZK proof WITHOUT revealing exact balances
4. ✓ Verified the proof cryptographically

The verifier now knows your wealth tier, but NOT:
  - Your exact balance amounts
  - Which specific wallets you own
  - Which blockchains your funds are on
```

## Troubleshooting

### "Failed to load config.json"
- Make sure `src/config.json` exists (copy from `config.example.json`)
- Check that JSON is valid

### "Proof generation failed"
- Ensure circuit is compiled: `cd packages/circuits && ./scripts/compile.sh`
- Ensure trusted setup is done: `cd packages/circuits && ./scripts/setup.sh`
- Check that `packages/circuits/build/keys/wealth_tier_final.zkey` exists

### "Failed to aggregate balances"
- Check API keys are valid
- Check wallet addresses are valid for their chains
- Check network connectivity
- Note: Historical balance fetching may be slow (~30-60 seconds)

### "Helius API error" or "Alchemy API error"
- Verify API keys are correct
- Check rate limits (free tiers have limits)
- Try again after a few minutes

## Next Steps

After validating the demo works:

1. Try different wallet addresses
2. Experiment with multi-wallet aggregation
3. Check the saved proof structure in `examples/test_proof.json`
4. Modify snapshots to test different time periods
5. Test edge cases (e.g., wallets with $0 balance)
