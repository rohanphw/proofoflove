/**
 * Represents a point in time for balance snapshot
 */
export interface Snapshot {
  /** Human-readable date */
  date: Date;
  /** Unix timestamp in seconds */
  unixTimestamp: number;
  /** Chain-specific identifier (Solana slot, Ethereum block, etc.) */
  chainIdentifier: number | string;
}

/**
 * Result of fetching balances at 3 snapshots
 */
export interface BalanceResult {
  /** Wallet address queried */
  walletAddress: string;
  /** Chain identifier (e.g., "solana", "ethereum") */
  chain: string;
  /** USD values in cents for each of the 3 snapshots */
  snapshots: [number, number, number];
  /** Optional: raw balance data for debugging */
  rawBalances?: any[];
}

/**
 * Interface that all chain adapters must implement
 */
export interface ChainAdapter {
  /** Chain identifier (e.g., "solana", "ethereum") */
  readonly chainName: string;

  /**
   * Fetch historical balances at 3 snapshots
   * @param walletAddress - Wallet to query
   * @param snapshots - 3 time points (~now, ~30d ago, ~60d ago)
   * @returns USD values in cents for each snapshot
   */
  fetchBalancesAtSnapshots(
    walletAddress: string,
    snapshots: [Snapshot, Snapshot, Snapshot]
  ): Promise<BalanceResult>;

  /**
   * Validate wallet address format
   * @param address - Address to validate
   * @returns true if valid, false otherwise
   */
  isValidAddress(address: string): boolean;
}

/**
 * Wallet specification for aggregation
 */
export interface WalletSpec {
  /** Chain identifier */
  chain: string;
  /** Wallet address */
  address: string;
}

/**
 * Configuration for adapters
 */
export interface AdapterConfig {
  /** API key for RPC provider */
  apiKey: string;
  /** Network (mainnet, testnet, devnet, etc.) */
  network?: string;
  /** Optional: custom RPC endpoint */
  rpcEndpoint?: string;
}
