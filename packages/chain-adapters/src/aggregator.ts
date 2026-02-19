import type { ChainAdapter, BalanceResult, Snapshot, WalletSpec } from './types.js';

/**
 * Aggregates balances from multiple wallets across multiple blockchains
 * This is the main entry point for fetching total net worth snapshots
 */
export class BalanceAggregator {
  private adapters: Map<string, ChainAdapter> = new Map();

  /**
   * Register a chain adapter
   * @param adapter - ChainAdapter instance for a specific blockchain
   */
  registerAdapter(adapter: ChainAdapter): void {
    this.adapters.set(adapter.chainName, adapter);
  }

  /**
   * Aggregate balances across all connected wallets
   * Returns 3 total USD values (in cents) - one for each snapshot
   *
   * @param wallets - Array of wallet specifications { chain, address }
   * @param snapshots - 3 time points to query balances
   * @returns Tuple of 3 total balances in USD cents
   */
  async aggregateBalances(
    wallets: WalletSpec[],
    snapshots: [Snapshot, Snapshot, Snapshot]
  ): Promise<[number, number, number]> {
    if (wallets.length === 0) {
      throw new Error('No wallets provided');
    }

    console.log(`Aggregating balances for ${wallets.length} wallet(s) at 3 snapshots...`);

    // Fetch balances for all wallets in parallel
    const promises = wallets.map(async (wallet, index) => {
      const adapter = this.adapters.get(wallet.chain);
      if (!adapter) {
        throw new Error(`No adapter registered for chain: ${wallet.chain}`);
      }

      console.log(`  [${index + 1}/${wallets.length}] Fetching ${wallet.chain} wallet: ${wallet.address.slice(0, 8)}...`);

      try {
        return await adapter.fetchBalancesAtSnapshots(wallet.address, snapshots);
      } catch (error) {
        console.error(`    ✗ Failed to fetch ${wallet.chain} wallet ${wallet.address}:`, error);
        // Return zero balances for failed wallets (don't block entire aggregation)
        return {
          walletAddress: wallet.address,
          chain: wallet.chain,
          snapshots: [0, 0, 0] as [number, number, number]
        };
      }
    });

    const results = await Promise.all(promises);

    // Sum balances across all wallets for each snapshot
    const totals: [number, number, number] = [0, 0, 0];

    for (const result of results) {
      totals[0] += result.snapshots[0];
      totals[1] += result.snapshots[1];
      totals[2] += result.snapshots[2];

      console.log(`    ✓ ${result.chain} balance: $${(result.snapshots[0] / 100).toFixed(2)}, $${(result.snapshots[1] / 100).toFixed(2)}, $${(result.snapshots[2] / 100).toFixed(2)}`);
    }

    console.log(`\nTotal aggregated balances:`);
    console.log(`  Snapshot 1 (${snapshots[0].date.toLocaleDateString()}): $${(totals[0] / 100).toFixed(2)}`);
    console.log(`  Snapshot 2 (${snapshots[1].date.toLocaleDateString()}): $${(totals[1] / 100).toFixed(2)}`);
    console.log(`  Snapshot 3 (${snapshots[2].date.toLocaleDateString()}): $${(totals[2] / 100).toFixed(2)}`);

    return totals;
  }

  /**
   * Generate 3 snapshot time points: ~now, ~30 days ago, ~60 days ago
   * These represent the 90-day lookback period for tier calculation
   */
  static generateSnapshots(): [Snapshot, Snapshot, Snapshot] {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    return [
      {
        date: now,
        unixTimestamp: Math.floor(now.getTime() / 1000),
        chainIdentifier: 'latest'
      },
      {
        date: thirtyDaysAgo,
        unixTimestamp: Math.floor(thirtyDaysAgo.getTime() / 1000),
        chainIdentifier: 0 // Will be determined by adapter
      },
      {
        date: sixtyDaysAgo,
        unixTimestamp: Math.floor(sixtyDaysAgo.getTime() / 1000),
        chainIdentifier: 0 // Will be determined by adapter
      }
    ];
  }

  /**
   * Get list of registered chains
   */
  getRegisteredChains(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Validate a wallet address for a specific chain
   */
  isValidWalletAddress(chain: string, address: string): boolean {
    const adapter = this.adapters.get(chain);
    if (!adapter) {
      throw new Error(`No adapter registered for chain: ${chain}`);
    }
    return adapter.isValidAddress(address);
  }
}
