import type {
  ChainAdapter,
  BalanceResult,
  Snapshot,
  WalletSpec,
} from "./types.js";

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
   * Wallets are fetched sequentially with a small delay between each
   * to avoid rate limiting from CoinGecko, Helius, and RPC providers.
   *
   * @param wallets - Array of wallet specifications { chain, address }
   * @param snapshots - 3 time points to query balances
   * @returns Tuple of 3 total balances in USD cents
   */
  async aggregateBalances(
    wallets: WalletSpec[],
    snapshots: [Snapshot, Snapshot, Snapshot],
  ): Promise<[number, number, number]> {
    if (wallets.length === 0) {
      throw new Error("No wallets provided");
    }

    console.log(
      `Aggregating balances for ${wallets.length} wallet(s) at 3 snapshots...`,
    );

    const results: BalanceResult[] = [];

    // Fetch wallets sequentially to avoid rate limiting
    for (let index = 0; index < wallets.length; index++) {
      const wallet = wallets[index];
      const adapter = this.adapters.get(wallet.chain);

      if (!adapter) {
        throw new Error(`No adapter registered for chain: ${wallet.chain}`);
      }

      console.log(
        `  [${index + 1}/${wallets.length}] Fetching ${wallet.chain} wallet: ${wallet.address.slice(0, 8)}...`,
      );

      try {
        const result = await adapter.fetchBalancesAtSnapshots(
          wallet.address,
          snapshots,
        );
        results.push(result);
      } catch (error) {
        console.error(
          `    ✗ Failed to fetch ${wallet.chain} wallet ${wallet.address}:`,
          error,
        );
        results.push({
          walletAddress: wallet.address,
          chain: wallet.chain,
          snapshots: [0, 0, 0] as [number, number, number],
        });
      }

      // Small delay between wallets to respect rate limits
      if (index < wallets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // Sum balances across all wallets for each snapshot
    const totals: [number, number, number] = [0, 0, 0];

    for (const result of results) {
      totals[0] += result.snapshots[0];
      totals[1] += result.snapshots[1];
      totals[2] += result.snapshots[2];

      console.log(
        `    ✓ ${result.chain} balance: $${(result.snapshots[0] / 100).toFixed(2)}, $${(result.snapshots[1] / 100).toFixed(2)}, $${(result.snapshots[2] / 100).toFixed(2)}`,
      );
    }

    console.log(`\nTotal aggregated balances:`);
    console.log(
      `  Snapshot 1 (${snapshots[0].date.toLocaleDateString()}): $${(totals[0] / 100).toFixed(2)}`,
    );
    console.log(
      `  Snapshot 2 (${snapshots[1].date.toLocaleDateString()}): $${(totals[1] / 100).toFixed(2)}`,
    );
    console.log(
      `  Snapshot 3 (${snapshots[2].date.toLocaleDateString()}): $${(totals[2] / 100).toFixed(2)}`,
    );

    return totals;
  }

  /**
   * Generate 3 snapshot time points: ~now, ~45 days ago, ~90 days ago
   * Evenly spaced across a full quarter for a more representative average.
   */
  static generateSnapshots(): [Snapshot, Snapshot, Snapshot] {
    const now = new Date();
    const fortyFiveDaysAgo = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    return [
      {
        date: now,
        unixTimestamp: Math.floor(now.getTime() / 1000),
        chainIdentifier: "latest",
      },
      {
        date: fortyFiveDaysAgo,
        unixTimestamp: Math.floor(fortyFiveDaysAgo.getTime() / 1000),
        chainIdentifier: 0,
      },
      {
        date: ninetyDaysAgo,
        unixTimestamp: Math.floor(ninetyDaysAgo.getTime() / 1000),
        chainIdentifier: 0,
      },
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
