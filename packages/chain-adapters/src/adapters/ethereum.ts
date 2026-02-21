import { ethers } from "ethers";
import type {
  ChainAdapter,
  Snapshot,
  BalanceResult,
  AdapterConfig,
} from "../types.js";

/**
 * Per-chain token configuration
 */
interface TokenConfig {
  address: string;
  symbol: string;
  stablecoin?: boolean;
  priceSymbol?: string;
}

/**
 * Chain-specific configuration
 */
interface EVMChainConfig {
  chainName: string;
  nativeSymbol: string;
  nativePriceSymbol: string;
  avgBlockTime: number;
  tokens: TokenConfig[];
  fallbackNativePrice: number;
}

/**
 * Known EVM chain configurations
 */
const CHAIN_CONFIGS: Record<string, EVMChainConfig> = {
  ethereum: {
    chainName: "ethereum",
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETH",
    avgBlockTime: 12,
    fallbackNativePrice: 2500,
    tokens: [
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        stablecoin: true,
      },
      {
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        stablecoin: true,
      },
      {
        address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        symbol: "WBTC",
        priceSymbol: "BTC",
      },
    ],
  },
  arbitrum: {
    chainName: "arbitrum",
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETH",
    avgBlockTime: 0.25,
    fallbackNativePrice: 2500,
    tokens: [
      {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        symbol: "USDC",
        stablecoin: true,
      },
      {
        address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
        symbol: "USDC.e",
        stablecoin: true,
      },
      {
        address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        symbol: "USDT",
        stablecoin: true,
      },
      {
        address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
        symbol: "WBTC",
        priceSymbol: "BTC",
      },
    ],
  },
  base: {
    chainName: "base",
    nativeSymbol: "ETH",
    nativePriceSymbol: "ETH",
    avgBlockTime: 2,
    fallbackNativePrice: 2500,
    tokens: [
      {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        stablecoin: true,
      },
      {
        address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
        symbol: "USDbC",
        stablecoin: true,
      },
    ],
  },
  hyperevm: {
    chainName: "hyperevm",
    nativeSymbol: "HYPE",
    nativePriceSymbol: "HYPE",
    avgBlockTime: 2,
    fallbackNativePrice: 0,
    tokens: [],
  },
};

// Pyth Hermes feed IDs for live price lookups
const HERMES_FEED_IDS: Record<string, string> = {
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  HYPE: "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
};

// ──────────────────────────────────────────────────────────
// Module-level price cache — shared across ALL EthereumAdapter instances
// ETH price on Feb 20 is the same whether queried from Ethereum, Arbitrum, or Base
// ──────────────────────────────────────────────────────────
const evmPriceCache = new Map<string, number>();

function priceCacheKey(symbol: string, timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${symbol}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Generic EVM adapter using JsonRpcProvider
 * Works with any EVM chain: Ethereum, Arbitrum, Base, HyperEVM, etc.
 *
 * Price resolution chain:
 *   Live (< 2 hours old):  Pyth Hermes → fallback
 *   Historical:            CoinGecko → Pyth TradingView → fallback
 */
export class EthereumAdapter implements ChainAdapter {
  readonly chainName: string;
  private provider: ethers.JsonRpcProvider;
  private chainConfig: EVMChainConfig;

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

    const rpcUrl = config.apiKey.startsWith("http")
      ? config.apiKey
      : `https://eth-mainnet.quiknode.pro/${config.apiKey}`;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot],
  ): Promise<BalanceResult> {
    const results: number[] = [];

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

      // Fetch ERC-20 balances
      const tokenBalances = await this.getERC20BalancesAtBlock(
        walletAddress,
        blockNumber,
      );

      // Get native token price (cached — ETH price shared across all EVM chains)
      const nativePrice = await this.getPriceAtTimestamp(
        this.chainConfig.nativePriceSymbol,
        snapshot.unixTimestamp,
      );

      // Convert to USD (in cents)
      let totalUsdCents = Math.floor(nativeBalanceFloat * nativePrice * 100);

      for (const token of tokenBalances) {
        totalUsdCents += Math.floor(token.balance * token.priceUsd * 100);
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

  /**
   * Get ERC-20 token balances at a specific block.
   * Stablecoins are priced at $1, non-stablecoins use CoinGecko/Hermes (cached).
   */
  private async getERC20BalancesAtBlock(
    address: string,
    blockNumber: number,
  ): Promise<
    Array<{
      contractAddress: string;
      symbol: string;
      balance: number;
      priceUsd: number;
    }>
  > {
    const balances: Array<{
      contractAddress: string;
      symbol: string;
      balance: number;
      priceUsd: number;
    }> = [];

    const ERC20_ABI = [
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ];

    for (const token of this.chainConfig.tokens) {
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
          const decimals = await contract.decimals();
          const balanceFloat = parseFloat(
            ethers.formatUnits(balance, decimals),
          );

          let priceUsd: number;
          if (token.stablecoin) {
            priceUsd = 1.0;
          } else if (token.priceSymbol) {
            priceUsd = await this.getPriceAtTimestamp(
              token.priceSymbol,
              Math.floor(Date.now() / 1000),
            );
          } else {
            priceUsd = 0;
          }

          balances.push({
            contractAddress: token.address,
            symbol: token.symbol,
            balance: balanceFloat,
            priceUsd,
          });
        }
      } catch (tokenError) {
        console.warn(
          `Failed to fetch ${token.symbol} balance on ${this.chainName}:`,
          tokenError,
        );
      }
    }

    return balances;
  }

  /**
   * Get price for ETH/HYPE/BTC.
   * - For "now" timestamps (within last 2 hours): use Pyth Hermes for live price
   * - For historical timestamps: try CoinGecko → Pyth TradingView → hardcoded fallback
   * Results are cached by symbol+date so ETH price is fetched once
   * and reused across Ethereum, Arbitrum, Base, etc.
   */
  private async getPriceAtTimestamp(
    symbol: string,
    timestamp: number,
  ): Promise<number> {
    const cacheKey = priceCacheKey(symbol, timestamp);
    const cached = evmPriceCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const nowSec = Math.floor(Date.now() / 1000);
    const isRecent = Math.abs(nowSec - timestamp) < 7200; // within 2 hours

    if (isRecent) {
      return this.getLivePriceFromHermes(symbol, cacheKey);
    }

    return this.getHistoricalPrice(symbol, timestamp, cacheKey);
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
      const fallback = this.chainConfig.fallbackNativePrice;
      evmPriceCache.set(cacheKey, fallback);
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
        evmPriceCache.set(cacheKey, price);
        return price;
      }

      throw new Error(`No parsed price in Hermes response for ${symbol}`);
    } catch (error) {
      console.warn(
        `Failed to fetch live price for ${symbol} from Hermes:`,
        error,
      );
      const fallback = this.chainConfig.fallbackNativePrice;
      evmPriceCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Fetch historical price with fallback chain:
   *   1. CoinGecko (best for major tokens, free tier can be flaky)
   *   2. Pyth TradingView (good for any Pyth-listed token including HYPE)
   *   3. Hardcoded fallback (last resort)
   */
  private async getHistoricalPrice(
    symbol: string,
    timestamp: number,
    cacheKey: string,
  ): Promise<number> {
    // Try CoinGecko first
    const coinGeckoPrice = await this.tryGetPriceFromCoinGecko(
      symbol,
      timestamp,
    );
    if (coinGeckoPrice !== null) {
      evmPriceCache.set(cacheKey, coinGeckoPrice);
      return coinGeckoPrice;
    }

    // Fall back to Pyth TradingView
    const pythPrice = await this.tryGetPriceFromPythTradingView(
      symbol,
      timestamp,
    );
    if (pythPrice !== null) {
      evmPriceCache.set(cacheKey, pythPrice);
      return pythPrice;
    }

    // Last resort: hardcoded fallback
    console.warn(
      `All price sources failed for ${symbol} at ${timestamp}, using fallback`,
    );
    const fallback = this.chainConfig.fallbackNativePrice;
    evmPriceCache.set(cacheKey, fallback);
    return fallback;
  }

  /**
   * Try fetching historical price from CoinGecko API.
   * Returns null on failure instead of throwing.
   */
  private async tryGetPriceFromCoinGecko(
    symbol: string,
    timestamp: number,
  ): Promise<number | null> {
    try {
      const COINGECKO_IDS: Record<string, string> = {
        ETH: "ethereum",
        BTC: "bitcoin",
        WBTC: "wrapped-bitcoin",
        HYPE: "hyperliquid",
      };

      const coinId = COINGECKO_IDS[symbol] || symbol.toLowerCase();
      const date = new Date(timestamp * 1000);
      const dateStr = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}`,
      );

      if (!response.ok) {
        console.warn(
          `CoinGecko failed for ${symbol}: ${response.statusText}, trying Pyth...`,
        );
        return null;
      }

      const data = (await response.json()) as {
        market_data?: { current_price?: { usd?: number } };
      };
      const price = data.market_data?.current_price?.usd;

      if (!price) {
        console.warn(
          `CoinGecko returned no price data for ${symbol} at ${dateStr}, trying Pyth...`,
        );
        return null;
      }

      return price;
    } catch (error) {
      console.warn(`CoinGecko error for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Try fetching historical price from Pyth TradingView API.
   * Returns null on failure instead of throwing.
   */
  private async tryGetPriceFromPythTradingView(
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

      if (!response.ok) {
        console.warn(
          `Pyth TradingView failed for ${symbol}: ${response.statusText}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        c?: number[];
        s?: string;
      };

      if (data.c && data.c.length > 0) {
        return data.c[0];
      }

      console.warn(`Pyth TradingView returned no candle data for ${symbol}`);
      return null;
    } catch (error) {
      console.warn(`Pyth TradingView error for ${symbol}:`, error);
      return null;
    }
  }

  isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }
}
