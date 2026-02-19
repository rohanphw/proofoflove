import { buildPoseidon } from 'circomlibjs';

/**
 * Generate nullifier from wallet addresses + user secret
 * This prevents proof reuse and multi-accounting
 *
 * Nullifier = Poseidon(Hash(sorted_wallet_addresses), Hash(user_secret))
 *
 * @param walletAddresses - Array of wallet addresses across all chains
 * @param userSecret - User-provided secret phrase (kept private)
 * @returns Nullifier as bigint
 */
export async function generateNullifier(
  walletAddresses: string[],
  userSecret: string
): Promise<bigint> {
  // Initialize Poseidon hash function
  const poseidon = await buildPoseidon();

  // Sort addresses for deterministic ordering
  const sorted = [...walletAddresses].sort();

  // Convert each address to bigint by hashing
  const addressBigInts = sorted.map(addr => {
    const bytes = Buffer.from(addr.toLowerCase(), 'utf8');
    // Take first 31 bytes to fit in field element
    const truncated = bytes.slice(0, 31);
    return BigInt('0x' + truncated.toString('hex'));
  });

  // Hash all addresses together
  const addressesHash = poseidon(addressBigInts);

  // Hash user secret
  const secretBytes = Buffer.from(userSecret, 'utf8').slice(0, 31);
  const secretBigInt = BigInt('0x' + secretBytes.toString('hex'));

  // Combine address hash with secret hash
  const nullifier = poseidon([addressesHash, secretBigInt]);

  // Convert from poseidon field element to bigint
  return poseidon.F.toObject(nullifier);
}

/**
 * Validate that a nullifier is in the correct format
 * @param nullifier - Nullifier to validate
 * @returns true if valid, false otherwise
 */
export function isValidNullifier(nullifier: bigint | string): boolean {
  try {
    const n = typeof nullifier === 'string' ? BigInt(nullifier) : nullifier;
    // Check that nullifier is positive and within reasonable bounds
    return n > 0n && n < 2n ** 256n;
  } catch {
    return false;
  }
}
