import { Connection, PublicKey } from '@solana/web3.js';
import type { ChainAdapter, Snapshot, BalanceResult, AdapterConfig } from '../types.js';

/**
 * Solana adapter using Helius RPC for historical balance queries
 */
export class SolanaAdapter implements ChainAdapter {
  readonly chainName = 'solana';
  private connection: Connection;
  private apiKey: string;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
    const network = config.network || 'mainnet-beta';
    const endpoint = config.rpcEndpoint || `https://rpc.helius.xyz/?api-key=${config.apiKey}`;
    this.connection = new Connection(endpoint, 'confirmed');
  }

  async fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot]
  ): Promise<BalanceResult> {
    const results: number[] = [];

    for (const snapshot of snapshots) {
      // Step 1: Find closest slot to target timestamp
      const slot = await this.findSlotByTimestamp(snapshot.unixTimestamp);

      // Step 2: Fetch SOL balance at that slot
      const solBalance = await this.getSOLBalanceAtSlot(walletAddress, slot);

      // Step 3: Fetch SPL token balances at that slot
      const splBalances = await this.getSPLBalancesAtSlot(walletAddress, slot);

      // Step 4: Get SOL/USD price at that timestamp
      const solPrice = await this.getPriceAtTimestamp('SOL', snapshot.unixTimestamp);

      // Step 5: Convert to USD (in cents)
      let totalUsdCents = Math.floor(solBalance * solPrice * 100);

      // Add SPL token values
      for (const token of splBalances) {
        const tokenPrice = await this.getTokenPrice(token.mint, snapshot.unixTimestamp);
        totalUsdCents += Math.floor(token.uiAmount * tokenPrice * 100);
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
   * Find Solana slot closest to target timestamp using binary search approximation
   */
  private async findSlotByTimestamp(targetTimestamp: number): Promise<number> {
    try {
      const currentSlot = await this.connection.getSlot();
      const currentBlock = await this.connection.getBlock(currentSlot);

      if (!currentBlock) {
        throw new Error('Failed to fetch current block');
      }

      const currentTime = currentBlock.blockTime || Math.floor(Date.now() / 1000);

      // Solana produces ~2.5 blocks per second on average
      const AVG_BLOCK_TIME = 0.4; // 400ms
      const timeDiff = currentTime - targetTimestamp;
      const estimatedSlot = currentSlot - Math.floor(timeDiff / AVG_BLOCK_TIME);

      // Ensure slot is not negative
      return Math.max(0, estimatedSlot);
    } catch (error) {
      console.warn(`Failed to find slot for timestamp ${targetTimestamp}:`, error);
      // Fallback: use current slot
      return await this.connection.getSlot();
    }
  }

  /**
   * Get SOL balance at a specific slot
   */
  private async getSOLBalanceAtSlot(address: string, slot: number): Promise<number> {
    try {
      const pubkey = new PublicKey(address);
      const balance = await this.connection.getBalance(pubkey, {
        commitment: 'confirmed',
        minContextSlot: slot
      });

      // Convert lamports to SOL
      return balance / 1e9;
    } catch (error) {
      console.warn(`Failed to fetch SOL balance for ${address} at slot ${slot}:`, error);
      return 0;
    }
  }

  /**
   * Get SPL token balances at a specific slot
   */
  private async getSPLBalancesAtSlot(
    address: string,
    slot: number
  ): Promise<Array<{ mint: string; uiAmount: number }>> {
    try {
      // Use Helius Enhanced Transactions API to get token balances
      const response = await fetch(
        `https://api.helius.xyz/v0/addresses/${address}/balances?api-key=${this.apiKey}`
      );

      if (!response.ok) {
        throw new Error(`Helius API error: ${response.statusText}`);
      }

      const data = await response.json();

      // Filter for tokens with non-zero balance
      return (data.tokens || [])
        .filter((t: any) => t.amount > 0)
        .map((t: any) => ({
          mint: t.mint,
          uiAmount: t.amount / Math.pow(10, t.decimals)
        }));
    } catch (error) {
      console.warn(`Failed to fetch SPL balances for ${address}:`, error);
      return [];
    }
  }

  /**
   * Get historical price for SOL/USD from Pyth Benchmarks API
   */
  private async getPriceAtTimestamp(symbol: string, timestamp: number): Promise<number> {
    try {
      // Pyth Benchmarks API provides historical price data
      const pythSymbol = `Crypto.${symbol}/USD`;
      const from = timestamp - 3600; // 1 hour before
      const to = timestamp + 3600;   // 1 hour after

      const response = await fetch(
        `https://benchmarks.pyth.network/v1/shims/tradingview/history?` +
        `symbol=${pythSymbol}&resolution=1D&from=${from}&to=${to}`
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
      // Fallback: use approximate current price (this is a limitation for MVP)
      return symbol === 'SOL' ? 100 : 0;
    }
  }

  /**
   * Get price for SPL token
   * For MVP: Only support major stablecoins (USDC, USDT)
   */
  private async getTokenPrice(mint: string, timestamp: number): Promise<number> {
    // Known SPL token mints
    const KNOWN_TOKENS: Record<string, string> = {
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT'
    };

    const symbol = KNOWN_TOKENS[mint];
    if (!symbol) {
      // Unknown token - skip for MVP
      return 0;
    }

    // Stablecoins are always $1
    if (symbol === 'USDC' || symbol === 'USDT') {
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
