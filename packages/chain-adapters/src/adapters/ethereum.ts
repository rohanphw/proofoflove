import { ethers } from 'ethers';
import type { ChainAdapter, Snapshot, BalanceResult, AdapterConfig } from '../types.js';

/**
 * Ethereum adapter using Alchemy for historical balance queries
 */
export class EthereumAdapter implements ChainAdapter {
  readonly chainName = 'ethereum';
  private provider: ethers.AlchemyProvider;
  private apiKey: string;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
    const network = config.network || 'mainnet';
    this.provider = new ethers.AlchemyProvider(network, config.apiKey);
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot]
  ): Promise<BalanceResult> {
    const results: number[] = [];

    for (const snapshot of snapshots) {
      // Step 1: Find block number closest to timestamp
      const blockNumber = await this.findBlockByTimestamp(snapshot.unixTimestamp);

      // Step 2: Fetch ETH balance at that block
      const ethBalance = await this.provider.getBalance(walletAddress, blockNumber);
      const ethBalanceFloat = parseFloat(ethers.formatEther(ethBalance));

      // Step 3: Fetch ERC-20 balances using Alchemy Token API
      const tokenBalances = await this.getERC20BalancesAtBlock(walletAddress, blockNumber);

      // Step 4: Get ETH/USD price at that timestamp
      const ethPrice = await this.getPriceAtTimestamp('ETH', snapshot.unixTimestamp);

      // Step 5: Convert to USD (in cents)
      let totalUsdCents = Math.floor(ethBalanceFloat * ethPrice * 100);

      // Add token values
      for (const token of tokenBalances) {
        const tokenPrice = await this.getTokenPrice(
          token.contractAddress,
          snapshot.unixTimestamp
        );
        totalUsdCents += Math.floor(token.balance * tokenPrice * 100);
      }

      results.push(totalUsdCents);
    }

    return {
      walletAddress,
      chain: this.chainName,
      snapshots: results as [number, number, number]
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
        throw new Error('Failed to fetch latest block');
      }

      const currentTime = latestBlockData.timestamp;
      const timeDiff = currentTime - targetTimestamp;

      // Ethereum produces ~1 block every 12 seconds
      const AVG_BLOCK_TIME = 12;
      const estimatedBlock = latestBlock - Math.floor(timeDiff / AVG_BLOCK_TIME);

      return Math.max(0, estimatedBlock);
    } catch (error) {
      console.warn(`Failed to find block for timestamp ${targetTimestamp}:`, error);
      // Fallback: use latest block
      return await this.provider.getBlockNumber();
    }
  }

  /**
   * Get ERC-20 token balances at a specific block using Alchemy's API
   */
  private async getERC20BalancesAtBlock(
    address: string,
    blockNumber: number
  ): Promise<Array<{ contractAddress: string; balance: number }>> {
    try {
      const url = `https://eth-mainnet.g.alchemy.com/v2/${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getTokenBalances',
          params: [
            address,
            'DEFAULT_TOKENS',
            { blockTag: `0x${blockNumber.toString(16)}` }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`Alchemy API error: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`Alchemy RPC error: ${data.error.message}`);
      }

      return (data.result?.tokenBalances || [])
        .filter((t: any) => t.tokenBalance !== '0x0' && t.tokenBalance !== '0x')
        .map((t: any) => ({
          contractAddress: t.contractAddress,
          balance: parseFloat(ethers.formatUnits(t.tokenBalance, 18))
        }));
    } catch (error) {
      console.warn(`Failed to fetch ERC-20 balances for ${address}:`, error);
      return [];
    }
  }

  /**
   * Get historical price from CoinGecko API
   */
  private async getPriceAtTimestamp(symbol: string, timestamp: number): Promise<number> {
    try {
      const coinId = symbol.toLowerCase();
      const date = new Date(timestamp * 1000);
      const dateStr = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${dateStr}`
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
      }

      const data = await response.json();
      const price = data.market_data?.current_price?.usd;

      if (!price) {
        throw new Error(`No price data for ${symbol} at ${dateStr}`);
      }

      return price;
    } catch (error) {
      console.warn(`Failed to fetch price for ${symbol}:`, error);
      // Fallback: use approximate current price (limitation for MVP)
      return symbol === 'ETH' ? 2500 : 0;
    }
  }

  /**
   * Get token price by contract address
   * For MVP: Support major tokens (USDC, USDT, WBTC)
   */
  private async getTokenPrice(
    contractAddress: string,
    timestamp: number
  ): Promise<number> {
    // Known ERC-20 token addresses (mainnet)
    const KNOWN_TOKENS: Record<string, string> = {
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'USDC',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7': 'USDT',
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 'WBTC'
    };

    const symbol = KNOWN_TOKENS[contractAddress];
    if (!symbol) {
      // Unknown token - skip for MVP
      return 0;
    }

    // Stablecoins are always $1
    if (symbol === 'USDC' || symbol === 'USDT') {
      return 1.0;
    }

    // For WBTC, get BTC price
    if (symbol === 'WBTC') {
      return this.getPriceAtTimestamp('BTC', timestamp);
    }

    return 0;
  }

  isValidAddress(address: string): boolean {
    return ethers.isAddress(address);
  }
}
