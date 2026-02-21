import { Connection, PublicKey } from "@solana/web3.js";
import type {
  ChainAdapter,
  Snapshot,
  BalanceResult,
  AdapterConfig,
} from "../types.js";

// ──────────────────────────────────────────────────────────
// Helius getTransactionsForAddress response types
// ──────────────────────────────────────────────────────────

interface GtfaRpcResponse {
  result?: { data: FullTransactionResult[] };
  error?: { message?: string; code?: number };
}

interface FullTransactionResult {
  slot: number;
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: Array<string | ParsedAccountKey>;
    };
  };
  meta: TransactionMeta | null;
}

interface TransactionMeta {
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalanceEntry[];
  postTokenBalances?: TokenBalanceEntry[];
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString?: string;
  };
}

interface ParsedAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

interface PythHistoryResponse {
  c?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  t?: number[];
  s?: string;
}

// Known SPL tokens we care about — everything else is ignored
// priceAs: use this symbol for price lookup (e.g. hSOL priced as SOL)
const KNOWN_SPL_TOKENS: Record<
  string,
  { symbol: string; stablecoin: boolean; priceAs?: string }
> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    stablecoin: true,
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    stablecoin: true,
  },
  he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A: {
    symbol: "hSOL",
    stablecoin: false,
    priceAs: "SOL",
  },
};

// Pyth Hermes feed IDs for live price lookups
const HERMES_FEED_IDS: Record<string, string> = {
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

// Module-level price cache shared across calls
const solPriceCache = new Map<string, number>();

function priceCacheKey(symbol: string, timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${symbol}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Solana adapter using Helius RPC for historical balance queries
 *
 * Fetches: SOL (priced via Pyth), USDC ($1), USDT ($1), hSOL (priced as SOL)
 * All other SPL tokens are ignored for MVP.
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chainName = "solana";
  private connection: Connection;
  private apiKey: string;
  private rpcEndpoint: string;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
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

      // Step 2: Get SPL token balances (USDC, USDT, hSOL)
      const splBalances = await this.getSPLBalancesAtTimestamp(
        walletAddress,
        snapshot.unixTimestamp,
      );

      // Step 3: Get SOL/USD price (cached per date)
      const solPrice = await this.getPriceAtTimestamp(
        "SOL",
        snapshot.unixTimestamp,
      );

      // Step 4: Convert to USD (in cents)
      let totalUsdCents = Math.floor(solBalance * solPrice * 100);

      // Add SPL token values
      for (const token of splBalances) {
        if (token.stablecoin) {
          // USDC/USDT = $1
          totalUsdCents += Math.floor(token.uiAmount * 100);
        } else {
          // Non-stablecoin: fetch price (hSOL uses SOL price via priceAs)
          const priceSymbol = token.priceAs || token.symbol;
          const price = await this.getPriceAtTimestamp(
            priceSymbol,
            snapshot.unixTimestamp,
          );
          totalUsdCents += Math.floor(token.uiAmount * price * 100);
        }
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
              sortOrder: "desc",
              limit: 1,
              filters: {
                blockTime: { lte: targetTimestamp },
                status: "succeeded",
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius RPC error: ${response.statusText}`);
      }

      const data = (await response.json()) as GtfaRpcResponse;

      if (data.error) {
        throw new Error(
          `RPC error: ${data.error.message || JSON.stringify(data.error)}`,
        );
      }

      const txs = data.result?.data;
      if (!txs || txs.length === 0) {
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
      }

      const postBalance = tx.meta?.postBalances?.[walletIndex];
      if (postBalance === undefined || postBalance === null) {
        return 0;
      }

      return postBalance / 1e9;
    } catch (error) {
      console.warn(
        `Failed to fetch historical SOL balance for ${address} at ${targetTimestamp}:`,
        error,
      );
      return this.getCurrentSOLBalance(address);
    }
  }

  /**
   * Get SPL token balances at a specific timestamp.
   * Only returns known tokens (USDC, USDT, hSOL) — all other mints are ignored.
   */
  private async getSPLBalancesAtTimestamp(
    address: string,
    targetTimestamp: number,
  ): Promise<
    Array<{
      mint: string;
      symbol: string;
      uiAmount: number;
      stablecoin: boolean;
      priceAs?: string;
    }>
  > {
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
              limit: 20,
              filters: {
                blockTime: { lte: targetTimestamp },
                status: "succeeded",
                tokenAccounts: "balanceChanged",
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius RPC error: ${response.statusText}`);
      }

      const data = (await response.json()) as GtfaRpcResponse;

      if (data.error) {
        throw new Error(
          `RPC error: ${data.error.message || JSON.stringify(data.error)}`,
        );
      }

      const txs = data.result?.data;
      if (!txs || txs.length === 0) {
        return [];
      }

      const latestByMint = new Map<
        string,
        {
          mint: string;
          symbol: string;
          uiAmount: number;
          stablecoin: boolean;
          priceAs?: string;
        }
      >();

      for (const tx of txs) {
        const postTokenBalances = tx.meta?.postTokenBalances || [];

        for (const tokenBal of postTokenBalances) {
          const owner = tokenBal.owner;
          const mint = tokenBal.mint;

          if (!mint || !owner) continue;
          if (owner !== address) continue;

          // Only track known tokens (USDC, USDT, hSOL)
          const knownToken = KNOWN_SPL_TOKENS[mint];
          if (!knownToken) continue;

          // Only take the first (most recent) occurrence per mint
          if (latestByMint.has(mint)) continue;

          const uiAmount =
            tokenBal.uiTokenAmount?.uiAmount ??
            parseFloat(tokenBal.uiTokenAmount?.amount || "0") /
              Math.pow(10, tokenBal.uiTokenAmount?.decimals || 0);

          if (uiAmount > 0) {
            latestByMint.set(mint, {
              mint,
              symbol: knownToken.symbol,
              uiAmount,
              stablecoin: knownToken.stablecoin,
              priceAs: knownToken.priceAs,
            });
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
   */
  private extractAccountKeys(tx: FullTransactionResult): string[] {
    const message = tx.transaction?.message;
    if (!message) return [];

    const accountKeys = message.accountKeys || [];
    return accountKeys.map((key) =>
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
   * Get price for SOL/USD (or any supported symbol).
   * - For "now" timestamps (within last 2 hours): use Pyth Hermes for live price
   * - For historical timestamps: use Pyth TradingView history
   * Cached per date so repeated calls are free.
   */
  private async getPriceAtTimestamp(
    symbol: string,
    timestamp: number,
  ): Promise<number> {
    const cacheKey = priceCacheKey(symbol, timestamp);
    const cached = solPriceCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200; // within 2 hours

    if (isRecent) {
      return this.getLivePriceFromHermes(symbol, cacheKey);
    }

    return this.getHistoricalPriceFromPyth(symbol, timestamp, cacheKey);
  }

  /**
   * Fetch live price from Pyth Hermes v2 API
   */
  private async getLivePriceFromHermes(
    symbol: string,
    cacheKey: string,
  ): Promise<number> {
    const feedId = HERMES_FEED_IDS[symbol];
    if (!feedId) {
      console.warn(`No Hermes feed ID for ${symbol}, using fallback`);
      const fallback = symbol === "SOL" ? 100 : 0;
      solPriceCache.set(cacheKey, fallback);
      return fallback;
    }

    try {
      const response = await fetch(
        `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`,
      );

      if (!response.ok) {
        throw new Error(`Hermes API error: ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      const priceFeed = data?.parsed?.[0]?.price;

      if (priceFeed) {
        const price = Number(priceFeed.price) * Math.pow(10, priceFeed.expo);
        solPriceCache.set(cacheKey, price);
        return price;
      }

      throw new Error(`No parsed price in Hermes response for ${symbol}`);
    } catch (error) {
      console.warn(
        `Failed to fetch live price for ${symbol} from Hermes:`,
        error,
      );
      const fallback = symbol === "SOL" ? 100 : 0;
      solPriceCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Fetch historical price from Pyth TradingView API
   */
  private async getHistoricalPriceFromPyth(
    symbol: string,
    timestamp: number,
    cacheKey: string,
  ): Promise<number> {
    try {
      const pythSymbol = `Crypto.${symbol}/USD`;
      const from = timestamp - 3600;
      const to = timestamp + 3600;

      const response = await fetch(
        `https://benchmarks.pyth.network/v1/shims/tradingview/history?` +
          `symbol=${pythSymbol}&resolution=1D&from=${from}&to=${to}`,
      );

      if (!response.ok) {
        throw new Error(`Pyth API error: ${response.statusText}`);
      }

      const data = (await response.json()) as PythHistoryResponse;
      if (data.c && data.c.length > 0) {
        const price = data.c[0];
        solPriceCache.set(cacheKey, price);
        return price;
      }

      throw new Error(`No price data for ${symbol} at ${timestamp}`);
    } catch (error) {
      console.warn(`Failed to fetch price for ${symbol}:`, error);
      const fallback = symbol === "SOL" ? 100 : 0;
      solPriceCache.set(cacheKey, fallback);
      return fallback;
    }
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
