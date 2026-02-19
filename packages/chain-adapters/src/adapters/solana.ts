import { Connection, PublicKey } from "@solana/web3.js";
import type {
  ChainAdapter,
  Snapshot,
  BalanceResult,
  AdapterConfig,
} from "../types.js";

/**
 * Solana adapter using Helius RPC for historical balance queries
 *
 * Uses Helius-exclusive `getTransactionsForAddress` method to reconstruct
 * historical balances from transaction metadata (preBalances/postBalances
 * and preTokenBalances/postTokenBalances).
 *
 * This is the only reliable way to get historical Solana account state
 * without running your own indexer — standard RPC methods like getBalance
 * and getTokenAccountsByOwner only return current state.
 *
 * Requires Helius Developer plan or higher (100 credits per gTFA call).
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chainName = "solana";
  private connection: Connection;
  private apiKey: string;
  private rpcEndpoint: string;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
    const network = config.network || "mainnet-beta";
    this.rpcEndpoint =
      config.rpcEndpoint ||
      `https://mainnet.helius-rpc.com/?api-key=${config.apiKey}`;
    this.connection = new Connection(this.rpcEndpoint, "confirmed");
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot],
  ): Promise<BalanceResult> {
    const results: number[] = [];

    for (const snapshot of snapshots) {
      // Step 1: Get SOL balance at target timestamp
      const solBalance = await this.getSOLBalanceAtTimestamp(
        walletAddress,
        snapshot.unixTimestamp,
      );

      // Step 2: Get SPL token balances at target timestamp
      const splBalances = await this.getSPLBalancesAtTimestamp(
        walletAddress,
        snapshot.unixTimestamp,
      );

      // Step 3: Get SOL/USD price at that timestamp
      const solPrice = await this.getPriceAtTimestamp(
        "SOL",
        snapshot.unixTimestamp,
      );

      // Step 4: Convert to USD (in cents)
      let totalUsdCents = Math.floor(solBalance * solPrice * 100);

      // Add SPL token values
      for (const token of splBalances) {
        const tokenPrice = await this.getTokenPrice(
          token.mint,
          snapshot.unixTimestamp,
        );
        totalUsdCents += Math.floor(token.uiAmount * tokenPrice * 100);
      }

      results.push(totalUsdCents);
    }

    return {
      walletAddress,
      chain: this.chainName,
      snapshots: results as [number, number, number],
    };
  }

  /**
   * Get SOL balance at a specific timestamp using getTransactionsForAddress.
   *
   * Strategy: Fetch the most recent transaction affecting this wallet at or before
   * the target timestamp. The transaction's postBalances array contains the SOL
   * balance of every account after that tx executed — giving us the historical balance.
   *
   * The wallet's own balance is at the index matching its position in accountKeys.
   */
  private async getSOLBalanceAtTimestamp(
    address: string,
    targetTimestamp: number,
  ): Promise<number> {
    try {
      const response = await fetch(this.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sol-balance-historical",
          method: "getTransactionsForAddress",
          params: [
            address,
            {
              transactionDetails: "full",
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              sortOrder: "desc", // newest first
              limit: 1, // only need the most recent tx before target
              filters: {
                blockTime: {
                  lte: targetTimestamp, // at or before target time
                },
                status: "succeeded", // only successful txs affect balances
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius RPC error: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(
          `RPC error: ${data.error.message || JSON.stringify(data.error)}`,
        );
      }

      const txs = data.result?.data;
      if (!txs || txs.length === 0) {
        // No transactions before this timestamp — wallet had 0 SOL at that point
        return 0;
      }

      const tx = txs[0];
      const accountKeys = this.extractAccountKeys(tx);
      const walletIndex = accountKeys.findIndex(
        (key: string) => key === address,
      );

      if (walletIndex === -1) {
        console.warn(
          `Wallet ${address} not found in accountKeys of most recent tx`,
        );
        return 0;
      }';;;;;'

      const postBalance = tx.meta?.postBalances?.[walletIndex];
      if (postBalance === undefined || postBalance === null) {
        return 0;
      }

      // Convert lamports to SOL
      return postBalance / 1e9;
    } catch (error) {
      console.warn(
        `Failed to fetch historical SOL balance for ${address} at ${targetTimestamp}:`,
        error,
      );
      // Fallback: fetch current balance (degraded accuracy for MVP)
      return this.getCurrentSOLBalance(address);
    }
  }

  /**
   * Get SPL token balances at a specific timestamp using getTransactionsForAddress.
   *
   * Strategy: Fetch the most recent transaction that changed any token balance
   * for this wallet. The transaction's postTokenBalances contains the token state
   * after execution.
   *
   * Uses tokenAccounts: "balanceChanged" to include ATA (Associated Token Account)
   * transactions — essential since tokens live in ATAs, not the wallet directly.
   *
   * CAVEAT: A single transaction's postTokenBalances only shows tokens involved
   * in THAT transaction, not all tokens the wallet holds. For a complete picture,
   * we'd need to scan back through multiple transactions. For MVP, we fetch a
   * small batch and merge the most recent state per mint.
   */
  private async getSPLBalancesAtTimestamp(
    address: string,
    targetTimestamp: number,
  ): Promise<Array<{ mint: string; uiAmount: number }>> {
    try {
      const response = await fetch(this.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "spl-balance-historical",
          method: "getTransactionsForAddress",
          params: [
            address,
            {
              transactionDetails: "full",
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
              sortOrder: "desc",
              limit: 20, // Fetch more txs to capture all token states
              filters: {
                blockTime: {
                  lte: targetTimestamp,
                },
                status: "succeeded",
                tokenAccounts: "balanceChanged", // Include ATA transactions
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius RPC error: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(
          `RPC error: ${data.error.message || JSON.stringify(data.error)}`,
        );
      }

      const txs = data.result?.data;
      if (!txs || txs.length === 0) {
        return [];
      }

      // Collect the most recent postTokenBalance per mint
      // Since txs are sorted desc (newest first), the first occurrence of each
      // mint is the most recent state
      const latestByMint = new Map<
        string,
        { mint: string; uiAmount: number }
      >();

      for (const tx of txs) {
        const accountKeys = this.extractAccountKeys(tx);
        const postTokenBalances: any[] = tx.meta?.postTokenBalances || [];

        for (const tokenBal of postTokenBalances) {
          // postTokenBalances references accounts by index into accountKeys
          // The "owner" field tells us who owns this token account
          const owner = tokenBal.owner;
          const mint = tokenBal.mint;

          if (!mint || !owner) continue;

          // Only include token balances owned by our wallet
          if (owner !== address) continue;

          // Only take the first (most recent) occurrence per mint
          if (latestByMint.has(mint)) continue;

          const uiAmount =
            tokenBal.uiTokenAmount?.uiAmount ??
            parseFloat(tokenBal.uiTokenAmount?.amount || "0") /
              Math.pow(10, tokenBal.uiTokenAmount?.decimals || 0);

          if (uiAmount > 0) {
            latestByMint.set(mint, { mint, uiAmount });
          }
        }
      }

      return Array.from(latestByMint.values());
    } catch (error) {
      console.warn(
        `Failed to fetch historical SPL balances for ${address} at ${targetTimestamp}:`,
        error,
      );
      return [];
    }
  }

  /**
   * Extract account keys from a transaction, handling both legacy and versioned formats.
   * jsonParsed encoding returns accountKeys as objects with { pubkey, signer, writable }
   * or as plain strings depending on the tx version.
   */
  private extractAccountKeys(tx: any): string[] {
    const message = tx.transaction?.message;
    if (!message) return [];

    const accountKeys = message.accountKeys || [];
    return accountKeys.map((key: any) =>
      typeof key === "string" ? key : key.pubkey,
    );
  }

  /**
   * Fallback: get current SOL balance (used when historical query fails)
   */
  private async getCurrentSOLBalance(address: string): Promise<number> {
    try {
      const pubkey = new PublicKey(address);
      const balance = await this.connection.getBalance(pubkey);
      return balance / 1e9;
    } catch {
      return 0;
    }
  }

  /**
   * Get historical price for SOL/USD from Pyth Benchmarks API
   */
  private async getPriceAtTimestamp(
    symbol: string,
    timestamp: number,
  ): Promise<number> {
    try {
      // Pyth Benchmarks API provides historical price data
      const pythSymbol = `Crypto.${symbol}/USD`;
      const from = timestamp - 3600; // 1 hour before
      const to = timestamp + 3600; // 1 hour after

      const response = await fetch(
        `https://benchmarks.pyth.network/v1/shims/tradingview/history?` +
          `symbol=${pythSymbol}&resolution=1D&from=${from}&to=${to}`,
      );

      if (!response.ok) {
        throw new Error(`Pyth API error: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.c && data.c.length > 0) {
        return data.c[0]; // Close price
      }

      throw new Error(`No price data for ${symbol} at ${timestamp}`);
    } catch (error) {
      console.warn(`Failed to fetch price for ${symbol}:`, error);
      // Fallback: use approximate current price (limitation for MVP)
      return symbol === "SOL" ? 100 : 0;
    }
  }

  /**
   * Get price for SPL token
   * For MVP: Only support major stablecoins (USDC, USDT)
   */
  private async getTokenPrice(
    mint: string,
    timestamp: number,
  ): Promise<number> {
    // Known SPL token mints
    const KNOWN_TOKENS: Record<string, string> = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    };

    const symbol = KNOWN_TOKENS[mint];
    if (!symbol) {
      // Unknown token — skip for MVP
      return 0;
    }

    // Stablecoins are always $1
    if (symbol === "USDC" || symbol === "USDT") {
      return 1.0;
    }

    // For other tokens, fetch price from Pyth
    return this.getPriceAtTimestamp(symbol, timestamp);
  }

  isValidAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
}
