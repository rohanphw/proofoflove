import { ethers } from "ethers";
import type {
  ChainAdapter,
  Snapshot,
  BalanceResult,
  AdapterConfig,
} from "../types.js";

/**
 * Chain-specific configuration
 */
interface EVMChainConfig {
  chainName: string;
  nativeSymbol: string;
  avgBlockTime: number;
  defillamaChainId: string; // for DeFiLlama API: "ethereum", "arbitrum", "base"
  fallbackNativePrice: number;
}

/**
 * Known EVM chain configurations
 */
const CHAIN_CONFIGS: Record<string, EVMChainConfig> = {
  ethereum: {
    chainName: "ethereum",
    nativeSymbol: "ETH",
    avgBlockTime: 12,
    defillamaChainId: "ethereum",
    fallbackNativePrice: 2500,
  },
  arbitrum: {
    chainName: "arbitrum",
    nativeSymbol: "ETH",
    avgBlockTime: 0.25,
    defillamaChainId: "arbitrum",
    fallbackNativePrice: 2500,
  },
  base: {
    chainName: "base",
    nativeSymbol: "ETH",
    avgBlockTime: 2,
    defillamaChainId: "base",
    fallbackNativePrice: 2500,
  },
  hyperevm: {
    chainName: "hyperevm",
    nativeSymbol: "HYPE",
    avgBlockTime: 2,
    defillamaChainId: "hyperliquid",
    fallbackNativePrice: 0,
  },
};

// Pyth Hermes feed IDs for native token live price lookups
const HERMES_FEED_IDS: Record<string, string> = {
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  HYPE: "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
};

// ──────────────────────────────────────────────────────────
// Module-level price cache — shared across ALL EthereumAdapter instances
// ──────────────────────────────────────────────────────────
const evmPriceCache = new Map<string, number>();

function priceCacheKey(id: string, timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${id}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Cache for discovered tokens per wallet+chain (avoids re-discovering every snapshot)
const discoveredTokensCache = new Map<
  string,
  Array<{ address: string; symbol: string; decimals: number }>
>();

/**
 * Generic EVM adapter using JsonRpcProvider
 * Works with any EVM chain: Ethereum, Arbitrum, Base, HyperEVM, etc.
 *
 * Token discovery: Uses qn_getWalletTokenBalance (QuickNode Token API) to
 * dynamically discover all ERC-20 tokens in a wallet. No hardcoded token lists.
 *
 * Price resolution:
 *   Live (< 2 hours old):  Pyth Hermes → DeFiLlama → fallback
 *   Historical:            DeFiLlama → Pyth TradingView → fallback
 */
export class EthereumAdapter implements ChainAdapter {
  readonly chainName: string;
  private provider: ethers.JsonRpcProvider;
  private chainConfig: EVMChainConfig;
  private rpcUrl: string;

  constructor(config: AdapterConfig) {
    const chainKey = config.network || "ethereum";
    const chainConfig = CHAIN_CONFIGS[chainKey];

    if (!chainConfig) {
      throw new Error(
        `Unknown EVM chain: ${chainKey}. Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
      );
    }

    this.chainConfig = chainConfig;
    this.chainName = chainConfig.chainName;

    this.rpcUrl = config.apiKey.startsWith("http")
      ? config.apiKey
      : `https://eth-mainnet.quiknode.pro/${config.apiKey}`;
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot],
  ): Promise<BalanceResult> {
    const results: number[] = [];

    // Step 1: Discover tokens in wallet (do this once, reuse for all snapshots)
    const tokens = await this.discoverTokens(walletAddress);

    for (const snapshot of snapshots) {
      const blockNumber = await this.findBlockByTimestamp(
        snapshot.unixTimestamp,
      );

      // Fetch native balance
      const nativeBalance = await this.provider.getBalance(
        walletAddress,
        blockNumber,
      );
      const nativeBalanceFloat = parseFloat(ethers.formatEther(nativeBalance));

      // Get native token price
      const nativePrice = await this.getNativePrice(snapshot.unixTimestamp);

      // Convert native to USD cents
      let totalUsdCents = Math.floor(nativeBalanceFloat * nativePrice * 100);

      // Fetch balances for discovered tokens at historical block
      const tokenBalances = await this.getTokenBalancesAtBlock(
        walletAddress,
        tokens,
        blockNumber,
      );

      // Price tokens via DeFiLlama (batch)
      const tokenPrices = await this.batchPriceTokens(
        tokenBalances.map((t) => t.address),
        snapshot.unixTimestamp,
      );

      for (const token of tokenBalances) {
        const price = tokenPrices.get(token.address.toLowerCase()) ?? 0;
        totalUsdCents += Math.floor(token.balance * price * 100);
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
   * Discover all ERC-20 tokens in a wallet.
   * Tries QuickNode Token API first (qn_getWalletTokenBalance),
   * falls back to empty list if not available (native-only).
   */
  private async discoverTokens(
    walletAddress: string,
  ): Promise<Array<{ address: string; symbol: string; decimals: number }>> {
    const cacheKey = `${this.chainName}:${walletAddress.toLowerCase()}`;
    const cached = discoveredTokensCache.get(cacheKey);
    if (cached) return cached;

    try {
      // Try QuickNode Token API
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 67,
          jsonrpc: "2.0",
          method: "qn_getWalletTokenBalance",
          params: [{ wallet: walletAddress, perPage: 100 }],
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as any;

      if (data.error) {
        throw new Error(data.error.message || "Token API not available");
      }

      const assets = data.result?.result || data.result?.assets || [];
      const tokens = assets
        .filter(
          (a: any) => a.address && a.totalBalance && a.totalBalance !== "0",
        )
        .map((a: any) => ({
          address: a.address,
          symbol: a.symbol || "UNKNOWN",
          decimals: parseInt(a.decimals || "18", 10),
        }));

      console.log(
        `[${this.chainName}] Discovered ${tokens.length} ERC-20 tokens via Token API`,
      );

      discoveredTokensCache.set(cacheKey, tokens);
      return tokens;
    } catch (error) {
      console.warn(
        `[${this.chainName}] Token API not available, using native-only:`,
        (error as Error).message,
      );
      discoveredTokensCache.set(cacheKey, []);
      return [];
    }
  }

  /**
   * Get ERC-20 token balances at a specific block for a list of tokens.
   */
  private async getTokenBalancesAtBlock(
    address: string,
    tokens: Array<{ address: string; symbol: string; decimals: number }>,
    blockNumber: number,
  ): Promise<
    Array<{
      address: string;
      symbol: string;
      balance: number;
    }>
  > {
    const balances: Array<{
      address: string;
      symbol: string;
      balance: number;
    }> = [];

    const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

    for (const token of tokens) {
      try {
        const contract = new ethers.Contract(
          token.address,
          ERC20_ABI,
          this.provider,
        );

        const balance = await contract.balanceOf(address, {
          blockTag: blockNumber,
        });

        if (balance > 0n) {
          const balanceFloat = parseFloat(
            ethers.formatUnits(balance, token.decimals),
          );

          balances.push({
            address: token.address,
            symbol: token.symbol,
            balance: balanceFloat,
          });
        }
      } catch {
        // Token may not exist at this historical block — skip silently
      }
    }

    return balances;
  }

  /**
   * Find block closest to target timestamp using average block time estimation
   */
  private async findBlockByTimestamp(targetTimestamp: number): Promise<number> {
    try {
      const latestBlock = await this.provider.getBlockNumber();
      const latestBlockData = await this.provider.getBlock(latestBlock);

      if (!latestBlockData) {
        throw new Error("Failed to fetch latest block");
      }

      const currentTime = latestBlockData.timestamp;
      const timeDiff = currentTime - targetTimestamp;

      if (timeDiff <= 0) {
        return latestBlock;
      }

      const estimatedBlock =
        latestBlock - Math.floor(timeDiff / this.chainConfig.avgBlockTime);

      return Math.max(0, Math.min(estimatedBlock, latestBlock));
    } catch (error) {
      console.warn(
        `Failed to find block for timestamp ${targetTimestamp}:`,
        error,
      );
      return await this.provider.getBlockNumber();
    }
  }

  // ──────────────────────────────────────────────────────────
  // Price Resolution
  // ──────────────────────────────────────────────────────────

  /**
   * Get native token price (ETH or HYPE).
   * Live: Pyth Hermes → DeFiLlama → fallback
   * Historical: DeFiLlama → Pyth TradingView → fallback
   */
  private async getNativePrice(timestamp: number): Promise<number> {
    const symbol = this.chainConfig.nativeSymbol;
    const cacheKey = priceCacheKey(`native:${symbol}`, timestamp);
    const cached = evmPriceCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200;

    if (isRecent) {
      // Try Pyth Hermes first for live price
      const hermesPrice = await this.tryHermesPrice(symbol);
      if (hermesPrice !== null) {
        evmPriceCache.set(cacheKey, hermesPrice);
        return hermesPrice;
      }
    }

    // DeFiLlama for native token (use coingecko: prefix for native assets)
    const llamaId =
      symbol === "ETH"
        ? "coingecko:ethereum"
        : symbol === "HYPE"
          ? "coingecko:hyperliquid"
          : `coingecko:${symbol.toLowerCase()}`;

    const llamaPrice = isRecent
      ? await this.tryDefiLlamaCurrentPrice(llamaId)
      : await this.tryDefiLlamaHistoricalPrice(llamaId, timestamp);

    if (llamaPrice !== null) {
      evmPriceCache.set(cacheKey, llamaPrice);
      return llamaPrice;
    }

    // Pyth TradingView fallback for historical
    if (!isRecent) {
      const pythPrice = await this.tryPythTradingView(symbol, timestamp);
      if (pythPrice !== null) {
        evmPriceCache.set(cacheKey, pythPrice);
        return pythPrice;
      }
    }

    // Last resort
    console.warn(
      `All price sources failed for native ${symbol}, using fallback`,
    );
    const fallback = this.chainConfig.fallbackNativePrice;
    evmPriceCache.set(cacheKey, fallback);
    return fallback;
  }

  /**
   * Batch-price ERC-20 tokens via DeFiLlama.
   * Returns a map of lowercase(address) → USD price.
   */
  private async batchPriceTokens(
    tokenAddresses: string[],
    timestamp: number,
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (tokenAddresses.length === 0) return prices;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200;

    // Check cache first, build list of uncached
    const uncached: string[] = [];
    for (const addr of tokenAddresses) {
      const cacheKey = priceCacheKey(
        `${this.chainConfig.defillamaChainId}:${addr.toLowerCase()}`,
        timestamp,
      );
      const cached = evmPriceCache.get(cacheKey);
      if (cached !== undefined) {
        prices.set(addr.toLowerCase(), cached);
      } else {
        uncached.push(addr);
      }
    }

    if (uncached.length === 0) return prices;

    // Build DeFiLlama coin IDs: "ethereum:0x...,ethereum:0x..."
    const coinIds = uncached
      .map(
        (addr) => `${this.chainConfig.defillamaChainId}:${addr.toLowerCase()}`,
      )
      .join(",");

    try {
      const url = isRecent
        ? `https://coins.llama.fi/prices/current/${coinIds}`
        : `https://coins.llama.fi/prices/historical/${timestamp}/${coinIds}`;

      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`DeFiLlama batch price failed: ${response.statusText}`);
        return prices;
      }

      const data = (await response.json()) as {
        coins: Record<
          string,
          { price: number; symbol: string; confidence?: number }
        >;
      };

      for (const addr of uncached) {
        const key = `${this.chainConfig.defillamaChainId}:${addr.toLowerCase()}`;
        const coinData = data.coins?.[key];
        const price = coinData?.price ?? 0;

        const cacheKey = priceCacheKey(key, timestamp);
        evmPriceCache.set(cacheKey, price);
        prices.set(addr.toLowerCase(), price);
      }
    } catch (error) {
      console.warn(`DeFiLlama batch price error:`, error);
    }

    return prices;
  }

  /**
   * Fetch live price from Pyth Hermes v2 API
   */
  private async tryHermesPrice(symbol: string): Promise<number | null> {
    const feedId = HERMES_FEED_IDS[symbol];
    if (!feedId) return null;

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
  private async tryDefiLlamaCurrentPrice(
    coinId: string,
  ): Promise<number | null> {
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
    return ethers.isAddress(address);
  }
}
