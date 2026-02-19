import { ethers } from "ethers";
import type {
  ChainAdapter,
  Snapshot,
  BalanceResult,
  AdapterConfig,
} from "../types.js";

/**
 * Ethereum adapter using Alchemy for historical balance queries
 */
export class EthereumAdapter implements ChainAdapter {
  readonly chainName = "ethereum";
  private provider: ethers.AlchemyProvider;
  private apiKey: string;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
    const network = config.network || "mainnet";
    this.provider = new ethers.AlchemyProvider(network, config.apiKey);
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot],
  ): Promise<BalanceResult> {
    const results: number[] = [];

    for (const snapshot of snapshots) {
      // Step 1: Find block number closest to timestamp
      const blockNumber = await this.findBlockByTimestamp(
        snapshot.unixTimestamp,
      );

      // Step 2: Fetch ETH balance at that block
      const ethBalance = await this.provider.getBalance(
        walletAddress,
        blockNumber,
      );
      const ethBalanceFloat = parseFloat(ethers.formatEther(ethBalance));

      // Step 3: Fetch ERC-20 balances using Alchemy Token API
      const tokenBalances = await this.getERC20BalancesAtBlock(
        walletAddress,
        blockNumber,
      );

      // Step 4: Get ETH/USD price at that timestamp
      const ethPrice = await this.getPriceAtTimestamp(
        "ETH",
        snapshot.unixTimestamp,
      );

      // Step 5: Convert to USD (in cents)
      let totalUsdCents = Math.floor(ethBalanceFloat * ethPrice * 100);

      // Add token values
      for (const token of tokenBalances) {
        const tokenPrice = await this.getTokenPrice(
          token.contractAddress,
          snapshot.unixTimestamp,
        );
        totalUsdCents += Math.floor(token.balance * tokenPrice * 100);
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
   * Find Ethereum block closest to target timestamp
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

      // Ethereum produces ~1 block every 12 seconds
      const AVG_BLOCK_TIME = 12;
      const estimatedBlock =
        latestBlock - Math.floor(timeDiff / AVG_BLOCK_TIME);

      return Math.max(0, estimatedBlock);
    } catch (error) {
      console.warn(
        `Failed to find block for timestamp ${targetTimestamp}:`,
        error,
      );
      // Fallback: use latest block
      return await this.provider.getBlockNumber();
    }
  }

  /**
   * Get ERC-20 token balances at a specific block using eth_call on balanceOf()
   * Note: alchemy_getTokenBalances does NOT support historical blockTag queries
   */
  private async getERC20BalancesAtBlock(
    address: string,
    blockNumber: number,
  ): Promise<Array<{ contractAddress: string; balance: number }>> {
    try {
      // Known ERC-20 token addresses (mainnet) - for MVP
      const KNOWN_TOKENS: Array<{ address: string; symbol: string }> = [
        {
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          symbol: "USDC",
        },
        {
          address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
          symbol: "USDT",
        },
        {
          address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
          symbol: "WBTC",
        },
      ];

      const balances: Array<{ contractAddress: string; balance: number }> = [];

      // Minimal ERC-20 ABI for balanceOf and decimals
      const ERC20_ABI = [
        "function balanceOf(address) view returns (uint256)",
        "function decimals() view returns (uint8)",
      ];

      for (const token of KNOWN_TOKENS) {
        try {
          const contract = new ethers.Contract(
            token.address,
            ERC20_ABI,
            this.provider,
          );

          // Query balance at historical block
          const balance = await contract.balanceOf(address, {
            blockTag: blockNumber,
          });

          if (balance > 0n) {
            // Query decimals for this token
            const decimals = await contract.decimals();

            // Convert to float using correct decimals
            const balanceFloat = parseFloat(
              ethers.formatUnits(balance, decimals),
            );

            balances.push({
              contractAddress: token.address,
              balance: balanceFloat,
            });
          }
        } catch (tokenError) {
          console.warn(`Failed to fetch ${token.symbol} balance:`, tokenError);
          // Continue with other tokens
        }
      }

      return balances;
    } catch (error) {
      console.warn(`Failed to fetch ERC-20 balances for ${address}:`, error);
      return [];
    }
  }

  /**
   * Get historical price from CoinGecko API
   */
  private async getPriceAtTimestamp(
    symbol: string,
    timestamp: number,
  ): Promise<number> {
    try {
      // Map symbols to CoinGecko coin IDs
      const COINGECKO_IDS: Record<string, string> = {
        ETH: "ethereum",
        BTC: "bitcoin",
        WBTC: "wrapped-bitcoin",
      };

      const coinId = COINGECKO_IDS[symbol] || symbol.toLowerCase();
      const date = new Date(timestamp * 1000);
      const dateStr = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}`,
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        market_data?: { current_price?: { usd?: number } };
      };
      const price = data.market_data?.current_price?.usd;

      if (!price) {
        throw new Error(`No price data for ${symbol} at ${dateStr}`);
      }

      return price;
    } catch (error) {
      console.warn(`Failed to fetch price for ${symbol}:`, error);
      // Fallback: use approximate current price (limitation for MVP)
      return symbol === "ETH" ? 2500 : 0;
    }
  }

  /**
   * Get token price by contract address
   * For MVP: Support major tokens (USDC, USDT, WBTC)
   */
  private async getTokenPrice(
    contractAddress: string,
    timestamp: number,
  ): Promise<number> {
    // Known ERC-20 token addresses (mainnet)
    const KNOWN_TOKENS: Record<string, string> = {
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7": "USDT",
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "WBTC",
    };

    const symbol = KNOWN_TOKENS[contractAddress];
    if (!symbol) {
      // Unknown token - skip for MVP
      return 0;
    }

    // Stablecoins are always $1
    if (symbol === "USDC" || symbol === "USDT") {
      return 1.0;
    }

    // For WBTC, get BTC price
    if (symbol === "WBTC") {
      return this.getPriceAtTimestamp("BTC", timestamp);
    }

    return 0;
  }

  isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }
}
