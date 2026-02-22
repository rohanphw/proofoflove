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

// ──────────────────────────────────────────────────────────
// DAS API response types (Helius getAssetsByOwner)
// ──────────────────────────────────────────────────────────

interface DasAssetResponse {
  result?: {
    total: number;
    items: DasAsset[];
    nativeBalance?: {
      lamports: number;
      price_per_sol?: number;
      total_price?: number;
    };
  };
}

interface DasAsset {
  id: string; // mint address
  interface: string; // "FungibleToken", "FungibleAsset", etc.
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  token_info?: {
    symbol?: string;
    balance?: number;
    decimals?: number;
    price_info?: {
      price_per_token?: number;
      total_price?: number;
      currency?: string;
    };
  };
}

// Known stablecoins on Solana (always priced at $1)
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Pyth Hermes feed IDs for live price lookups
const HERMES_FEED_IDS: Record<string, string> = {
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
};

// Module-level price cache shared across calls
const solPriceCache = new Map<string, number>();

function priceCacheKey(id: string, timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${id}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Cache for discovered mints per wallet
const discoveredMintsCache = new Map<
  string,
  Array<{ mint: string; symbol: string; decimals: number }>
>();

/**
 * Solana adapter using Helius RPC for historical balance queries
 *
 * Token discovery:
 *   - Current snapshot: Helius DAS (getAssetsByOwner) — returns all tokens with USD prices
 *   - Historical snapshots: getTransactionsForAddress — discovers all mints dynamically
 *
 * Price resolution:
 *   - Current: Helius DAS provides prices, fallback to Jupiter Price API
 *   - Historical: DeFiLlama → Pyth TradingView → fallback
 *   - Stablecoins (USDC, USDT): always $1
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

    // Pre-discover tokens using DAS (for current holdings)
    await this.discoverTokensViaDAS(walletAddress);

    for (const snapshot of snapshots) {
      const nowSec = Math.floor(Date.now() / 1000);
      const isRecent = Math.abs(nowSec - snapshot.unixTimestamp) < 7200;

      if (isRecent) {
        // Use DAS for current snapshot — gives us everything with prices
        const totalCents = await this.getCurrentBalanceViaDAS(walletAddress);
        results.push(totalCents);
      } else {
        // Historical: use getTransactionsForAddress
        const totalCents = await this.getHistoricalBalance(
          walletAddress,
          snapshot.unixTimestamp,
        );
        results.push(totalCents);
      }
    }

    return {
      walletAddress,
      chain: this.chainName,
      snapshots: results as [number, number, number],
    };
  }

  /**
   * Get current total USD balance via Helius DAS API.
   * Returns all fungible tokens with prices in a single call.
   */
  private async getCurrentBalanceViaDAS(
    walletAddress: string,
  ): Promise<number> {
    try {
      const response = await fetch(this.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "das-balance",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: walletAddress,
            page: 1,
            limit: 1000,
            displayOptions: {
              showFungible: true,
              showNativeBalance: true,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`DAS API error: ${response.statusText}`);
      }

      const data = (await response.json()) as DasAssetResponse;

      if (!data.result) {
        throw new Error("No result from DAS API");
      }

      let totalUsdCents = 0;

      // Native SOL balance
      if (data.result.nativeBalance) {
        const solBalance = data.result.nativeBalance.lamports / 1e9;
        const solPrice =
          data.result.nativeBalance.price_per_sol ??
          (await this.getSOLPrice(Math.floor(Date.now() / 1000)));
        totalUsdCents += Math.floor(solBalance * solPrice * 100);
      }

      // Fungible tokens
      for (const asset of data.result.items) {
        if (
          asset.interface !== "FungibleToken" &&
          asset.interface !== "FungibleAsset"
        )
          continue;

        const tokenInfo = asset.token_info;
        if (!tokenInfo) continue;

        // If DAS provides a total_price, use it directly
        if (tokenInfo.price_info?.total_price) {
          totalUsdCents += Math.floor(tokenInfo.price_info.total_price * 100);
          continue;
        }

        // Otherwise compute from balance + price
        const balance = tokenInfo.balance ?? 0;
        const decimals = tokenInfo.decimals ?? 0;
        const uiAmount = balance / Math.pow(10, decimals);

        if (uiAmount <= 0) continue;

        if (STABLECOIN_MINTS.has(asset.id)) {
          totalUsdCents += Math.floor(uiAmount * 100);
        } else if (tokenInfo.price_info?.price_per_token) {
          totalUsdCents += Math.floor(
            uiAmount * tokenInfo.price_info.price_per_token * 100,
          );
        } else {
          // Try Jupiter for price
          const price = await this.tryJupiterPrice(asset.id);
          if (price !== null) {
            totalUsdCents += Math.floor(uiAmount * price * 100);
          }
        }
      }

      return totalUsdCents;
    } catch (error) {
      console.warn(
        `DAS API failed for ${walletAddress}, falling back to historical method:`,
        error,
      );
      return this.getHistoricalBalance(
        walletAddress,
        Math.floor(Date.now() / 1000),
      );
    }
  }

  /**
   * Get historical total balance using getTransactionsForAddress.
   * Dynamically discovers all SPL tokens — no hardcoded list.
   */
  private async getHistoricalBalance(
    walletAddress: string,
    targetTimestamp: number,
  ): Promise<number> {
    // Step 1: Get SOL balance
    const solBalance = await this.getSOLBalanceAtTimestamp(
      walletAddress,
      targetTimestamp,
    );

    // Step 2: Get ALL SPL token balances (dynamic discovery)
    const splBalances = await this.getSPLBalancesAtTimestamp(
      walletAddress,
      targetTimestamp,
    );

    // Step 3: Get SOL price
    const solPrice = await this.getSOLPrice(targetTimestamp);

    // Step 4: Convert to USD cents
    let totalUsdCents = Math.floor(solBalance * solPrice * 100);

    // Step 5: Price SPL tokens
    if (splBalances.length > 0) {
      // Batch price non-stablecoin tokens via DeFiLlama
      const nonStableTokens = splBalances.filter(
        (t) => !STABLECOIN_MINTS.has(t.mint),
      );
      const stableTokens = splBalances.filter((t) =>
        STABLECOIN_MINTS.has(t.mint),
      );

      // Stablecoins at $1
      for (const token of stableTokens) {
        totalUsdCents += Math.floor(token.uiAmount * 100);
      }

      // Non-stablecoins via DeFiLlama
      if (nonStableTokens.length > 0) {
        const prices = await this.batchPriceSolanaTokens(
          nonStableTokens.map((t) => t.mint),
          targetTimestamp,
        );

        for (const token of nonStableTokens) {
          const price = prices.get(token.mint) ?? 0;
          if (price > 0) {
            totalUsdCents += Math.floor(token.uiAmount * price * 100);
          }
        }
      }
    }

    return totalUsdCents;
  }

  /**
   * Discover tokens via DAS for cache (used to know which mints to look for historically)
   */
  private async discoverTokensViaDAS(walletAddress: string): Promise<void> {
    const cacheKey = walletAddress.toLowerCase();
    if (discoveredMintsCache.has(cacheKey)) return;

    try {
      const response = await fetch(this.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "das-discover",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: walletAddress,
            page: 1,
            limit: 1000,
            displayOptions: { showFungible: true },
          },
        }),
      });

      const data = (await response.json()) as DasAssetResponse;
      const mints =
        data.result?.items
          ?.filter(
            (a) =>
              a.interface === "FungibleToken" ||
              a.interface === "FungibleAsset",
          )
          .map((a) => ({
            mint: a.id,
            symbol:
              a.token_info?.symbol || a.content?.metadata?.symbol || "UNKNOWN",
            decimals: a.token_info?.decimals ?? 0,
          })) ?? [];

      console.log(
        `[solana] Discovered ${mints.length} fungible tokens via DAS`,
      );
      discoveredMintsCache.set(cacheKey, mints);
    } catch (error) {
      console.warn(`DAS discovery failed:`, error);
      discoveredMintsCache.set(cacheKey, []);
    }
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
   * Get ALL SPL token balances at a specific timestamp.
   * No hardcoded token list — discovers all mints from postTokenBalances.
   */
  private async getSPLBalancesAtTimestamp(
    address: string,
    targetTimestamp: number,
  ): Promise<
    Array<{
      mint: string;
      symbol: string;
      uiAmount: number;
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

      // Get known symbols from DAS cache
      const dasCache = discoveredMintsCache.get(address.toLowerCase()) ?? [];
      const mintSymbolMap = new Map<
        string,
        { symbol: string; decimals: number }
      >();
      for (const m of dasCache) {
        mintSymbolMap.set(m.mint, {
          symbol: m.symbol,
          decimals: m.decimals,
        });
      }

      // Collect latest balance per mint (no filtering — take everything)
      const latestByMint = new Map<
        string,
        { mint: string; symbol: string; uiAmount: number }
      >();

      for (const tx of txs) {
        const postTokenBalances = tx.meta?.postTokenBalances || [];

        for (const tokenBal of postTokenBalances) {
          const owner = tokenBal.owner;
          const mint = tokenBal.mint;

          if (!mint || !owner) continue;
          if (owner !== address) continue;

          // Only take the first (most recent) occurrence per mint
          if (latestByMint.has(mint)) continue;

          const uiAmount =
            tokenBal.uiTokenAmount?.uiAmount ??
            parseFloat(tokenBal.uiTokenAmount?.amount || "0") /
              Math.pow(10, tokenBal.uiTokenAmount?.decimals || 0);

          if (uiAmount > 0) {
            const known = mintSymbolMap.get(mint);
            latestByMint.set(mint, {
              mint,
              symbol: known?.symbol || "UNKNOWN",
              uiAmount,
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

  // ──────────────────────────────────────────────────────────
  // Price Resolution
  // ──────────────────────────────────────────────────────────

  /**
   * Get SOL/USD price.
   * Live: Pyth Hermes → DeFiLlama → fallback
   * Historical: DeFiLlama → Pyth TradingView → fallback
   */
  private async getSOLPrice(timestamp: number): Promise<number> {
    const cacheKey = priceCacheKey("native:SOL", timestamp);
    const cached = solPriceCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200;

    if (isRecent) {
      const hermesPrice = await this.tryHermesPrice();
      if (hermesPrice !== null) {
        solPriceCache.set(cacheKey, hermesPrice);
        return hermesPrice;
      }
    }

    // DeFiLlama
    const llamaPrice = isRecent
      ? await this.tryDefiLlamaPrice("coingecko:solana")
      : await this.tryDefiLlamaHistoricalPrice("coingecko:solana", timestamp);

    if (llamaPrice !== null) {
      solPriceCache.set(cacheKey, llamaPrice);
      return llamaPrice;
    }

    // Pyth TradingView fallback
    if (!isRecent) {
      const pythPrice = await this.tryPythTradingView("SOL", timestamp);
      if (pythPrice !== null) {
        solPriceCache.set(cacheKey, pythPrice);
        return pythPrice;
      }
    }

    console.warn(`All SOL price sources failed, using fallback`);
    const fallback = 100;
    solPriceCache.set(cacheKey, fallback);
    return fallback;
  }

  /**
   * Batch-price Solana SPL tokens via DeFiLlama.
   * Uses "solana:{mint}" format for DeFiLlama lookups.
   */
  private async batchPriceSolanaTokens(
    mints: string[],
    timestamp: number,
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (mints.length === 0) return prices;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200;

    // Check cache first
    const uncached: string[] = [];
    for (const mint of mints) {
      const cacheKey = priceCacheKey(`solana:${mint}`, timestamp);
      const cached = solPriceCache.get(cacheKey);
      if (cached !== undefined) {
        prices.set(mint, cached);
      } else {
        uncached.push(mint);
      }
    }

    if (uncached.length === 0) return prices;

    // Build DeFiLlama coin IDs
    const coinIds = uncached.map((mint) => `solana:${mint}`).join(",");

    try {
      const url = isRecent
        ? `https://coins.llama.fi/prices/current/${coinIds}`
        : `https://coins.llama.fi/prices/historical/${timestamp}/${coinIds}`;

      const response = await fetch(url);

      if (!response.ok) {
        console.warn(
          `DeFiLlama Solana batch price failed: ${response.statusText}`,
        );
        // Fall back to Jupiter for live prices
        if (isRecent) {
          return this.fallbackJupiterBatchPrice(uncached, prices);
        }
        return prices;
      }

      const data = (await response.json()) as {
        coins: Record<string, { price: number }>;
      };

      const stillMissing: string[] = [];

      for (const mint of uncached) {
        const key = `solana:${mint}`;
        const coinData = data.coins?.[key];

        if (coinData?.price) {
          const cacheKey = priceCacheKey(key, timestamp);
          solPriceCache.set(cacheKey, coinData.price);
          prices.set(mint, coinData.price);
        } else {
          stillMissing.push(mint);
        }
      }

      // For any tokens DeFiLlama doesn't know, try Jupiter (live only)
      if (isRecent && stillMissing.length > 0) {
        await this.fallbackJupiterBatchPrice(stillMissing, prices);
      }
    } catch (error) {
      console.warn(`DeFiLlama Solana batch price error:`, error);
    }

    return prices;
  }

  /**
   * Fallback: batch-price via Jupiter Price API for live prices.
   */
  private async fallbackJupiterBatchPrice(
    mints: string[],
    prices: Map<string, number>,
  ): Promise<Map<string, number>> {
    // Jupiter supports comma-separated mint addresses
    const ids = mints.join(",");

    try {
      const response = await fetch(`https://api.jup.ag/price/v2?ids=${ids}`);

      if (!response.ok) return prices;

      const data = (await response.json()) as {
        data: Record<string, { price: string }>;
      };

      for (const mint of mints) {
        const tokenData = data.data?.[mint];
        if (tokenData?.price) {
          const price = parseFloat(tokenData.price);
          const cacheKey = priceCacheKey(
            `solana:${mint}`,
            Math.floor(Date.now() / 1000),
          );
          solPriceCache.set(cacheKey, price);
          prices.set(mint, price);
        }
      }
    } catch (error) {
      console.warn(`Jupiter batch price error:`, error);
    }

    return prices;
  }

  /**
   * Get price for a single Solana token via Jupiter Price API
   */
  private async tryJupiterPrice(mint: string): Promise<number | null> {
    try {
      const response = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);

      if (!response.ok) return null;

      const data = (await response.json()) as {
        data: Record<string, { price: string }>;
      };

      const price = data.data?.[mint]?.price;
      return price ? parseFloat(price) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch live SOL price from Pyth Hermes
   */
  private async tryHermesPrice(): Promise<number | null> {
    const feedId = HERMES_FEED_IDS["SOL"];
    try {
      const response = await fetch(
        `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&parsed=true`,
      );

      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const priceFeed = data?.parsed?.[0]?.price;

      if (priceFeed) {
        return Number(priceFeed.price) * Math.pow(10, priceFeed.expo);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch current price from DeFiLlama
   */
  private async tryDefiLlamaPrice(coinId: string): Promise<number | null> {
    try {
      const response = await fetch(
        `https://coins.llama.fi/prices/current/${coinId}`,
      );

      if (!response.ok) return null;

      const data = (await response.json()) as {
        coins: Record<string, { price: number }>;
      };

      return data.coins?.[coinId]?.price ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch historical price from DeFiLlama
   */
  private async tryDefiLlamaHistoricalPrice(
    coinId: string,
    timestamp: number,
  ): Promise<number | null> {
    try {
      const response = await fetch(
        `https://coins.llama.fi/prices/historical/${timestamp}/${coinId}`,
      );

      if (!response.ok) return null;

      const data = (await response.json()) as {
        coins: Record<string, { price: number }>;
      };

      return data.coins?.[coinId]?.price ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch historical price from Pyth TradingView API (fallback)
   */
  private async tryPythTradingView(
    symbol: string,
    timestamp: number,
  ): Promise<number | null> {
    try {
      const pythSymbol = `Crypto.${symbol}/USD`;
      const from = timestamp - 3600;
      const to = timestamp + 3600;

      const response = await fetch(
        `https://benchmarks.pyth.network/v1/shims/tradingview/history?` +
          `symbol=${pythSymbol}&resolution=1D&from=${from}&to=${to}`,
      );

      if (!response.ok) return null;

      const data = (await response.json()) as { c?: number[] };
      return data.c && data.c.length > 0 ? data.c[0] : null;
    } catch {
      return null;
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
