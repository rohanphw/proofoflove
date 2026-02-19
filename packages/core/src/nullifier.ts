import { buildPoseidon } from "circomlibjs";

// ──────────────────────────────────────────────────────────
// circomlibjs Poseidon types (not exported by the library)
// ──────────────────────────────────────────────────────────

interface PoseidonF {
  toObject(el: Uint8Array): bigint;
}

interface PoseidonFn {
  (inputs: bigint[]): Uint8Array;
  F: PoseidonF;
}

// ──────────────────────────────────────────────────────────
// Nullifier generation
// ──────────────────────────────────────────────────────────

/**
 * Generate nullifier from wallet addresses + user secret.
 * This prevents proof reuse and multi-accounting.
 *
 * Nullifier = Poseidon(Hash(sorted_wallet_addresses), Hash(user_secret))
 *
 * Uses iterative Poseidon hashing to support variable number of wallets
 * (Poseidon has fixed arity, so we chain: hash(hash(a, b), c) ...)
 *
 * For a single wallet, we still run it through Poseidon once so the
 * security properties are consistent regardless of wallet count.
 *
 * @param walletAddresses - Array of wallet addresses across all chains
 * @param userSecret - User-provided secret phrase (kept private)
 * @returns Nullifier as bigint
 */
export async function generateNullifier(
  walletAddresses: string[],
  userSecret: string,
): Promise<bigint> {
  if (walletAddresses.length === 0) {
    throw new Error("At least one wallet address is required");
  }

  // Initialize Poseidon hash function
  const poseidon = (await buildPoseidon()) as PoseidonFn;

  // Sort addresses for deterministic ordering
  const sorted = [...walletAddresses].sort();

  // Convert each address to bigint by taking first 31 bytes (fits in BN254 field)
  const addressBigInts = sorted.map((addr) => {
    const bytes = Buffer.from(addr.toLowerCase(), "utf8");
    const truncated = bytes.subarray(0, 31);
    return BigInt("0x" + truncated.toString("hex"));
  });

  // Hash all addresses together using iterative Poseidon hashing.
  // Always hash through Poseidon at least once (even for single wallet)
  // so security properties are consistent regardless of wallet count.
  let addressesHash = poseidon.F.toObject(poseidon([addressBigInts[0]]));
  for (let i = 1; i < addressBigInts.length; i++) {
    addressesHash = poseidon.F.toObject(
      poseidon([addressesHash, addressBigInts[i]]),
    );
  }

  // Hash user secret
  const secretBytes = Buffer.from(userSecret, "utf8").subarray(0, 31);
  const secretBigInt = BigInt("0x" + secretBytes.toString("hex"));

  // Combine address hash with secret
  const nullifier = poseidon([addressesHash, secretBigInt]);

  return poseidon.F.toObject(nullifier);
}

/**
 * Validate that a nullifier is in the correct format
 * @param nullifier - Nullifier to validate
 * @returns true if valid, false otherwise
 */
export function isValidNullifier(nullifier: bigint | string): boolean {
  try {
    const n = typeof nullifier === "string" ? BigInt(nullifier) : nullifier;
    return n > 0n && n < 2n ** 256n;
  } catch {
    return false;
  }
}
