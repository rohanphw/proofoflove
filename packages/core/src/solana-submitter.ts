/**
 * solana-submitter.ts
 *
 * Takes a snarkjs Groth16 proof + public signals, converts them to the byte
 * format expected by the on-chain proof_of_love Anchor program, and submits
 * the transaction to Solana.
 *
 * Usage (Node / CLI):
 *   import { submitProofToSolana } from './solana-submitter';
 *   const txSig = await submitProofToSolana({ proof, publicSignals, wallet, connection });
 *
 * Usage (Browser with wallet adapter):
 *   import { buildVerifyInstruction, deriveProofBadgePDA } from './solana-submitter';
 *   const ix = buildVerifyInstruction({ proof, publicSignals, userPubkey, programId });
 *   // send via wallet adapter
 *
 * Key details:
 *   - proof_a y-coordinate must be negated (Groth16 verification equation)
 *   - Public inputs are 32-byte big-endian: [tierLower, tierUpper, nullifier, timestamp]
 *   - PDA seeds: [b"tier_badge", user_pubkey]
 */

import { createHash } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Program ID from the Anchor build */
export const PROGRAM_ID = new PublicKey(
  "BBDtJxqUFWpCXMvZjtCFQyYGJ698o84H3RpqcJQjnGLR",
);

/** Number of public inputs the circuit outputs */
export const NR_PUBLIC_INPUTS = 4;

/** PDA seed prefix */
const TIER_BADGE_SEED = Buffer.from("tier_badge");

/**
 * The alt_bn128 curve order (field modulus for Fr / Fq).
 * Used to negate the proof_a y-coordinate: neg_y = CURVE_ORDER - y
 */
const CURVE_ORDER = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw snarkjs proof JSON (from groth16.fullProve) */
export interface SnarkjsProof {
  pi_a: [string, string, string]; // G1 point [x, y, z] (affine: z=1)
  pi_b: [[string, string], [string, string], [string, string]]; // G2 point
  pi_c: [string, string, string]; // G1 point
  protocol: string;
  curve: string;
}

/** The 4 public signals from our circuit, as decimal strings */
export type PublicSignals = [string, string, string, string];

/** Options for building the verify instruction */
export interface BuildInstructionOptions {
  proof: SnarkjsProof;
  publicSignals: PublicSignals;
  userPubkey: PublicKey;
  programId?: PublicKey;
}

/** Options for the full submit flow */
export interface SubmitOptions {
  proof: SnarkjsProof;
  publicSignals: PublicSignals;
  wallet: Keypair;
  connection: Connection;
  programId?: PublicKey;
  /** If true, skip preflight simulation (useful for localnet) */
  skipPreflight?: boolean;
}

/** Result of a successful on-chain verification */
export interface SubmitResult {
  txSignature: string;
  tierBadgePDA: PublicKey;
  tier: number;
}

// ---------------------------------------------------------------------------
// Byte conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a decimal string to a 32-byte big-endian Uint8Array.
 * This is the format groth16-solana expects for both curve points and
 * public inputs.
 */
export function decimalTo32BytesBE(decStr: string): Uint8Array {
  let bn = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(bn & 0xffn);
    bn >>= 8n;
  }
  return bytes;
}

/**
 * Negate a y-coordinate on the alt_bn128 curve.
 * groth16-solana requires proof_a with negated y for the pairing check.
 *
 * neg_y = CURVE_ORDER - y
 */
export function negateY(yDecStr: string): string {
  const y = BigInt(yDecStr);
  if (y === 0n) return "0";
  const negY = CURVE_ORDER - y;
  return negY.toString();
}

/**
 * Convert snarkjs proof_a (G1 affine point) to 64 bytes [x(32) | neg_y(32)].
 * The y-coordinate is negated for the Groth16 verification equation.
 */
export function encodeProofA(pi_a: SnarkjsProof["pi_a"]): Uint8Array {
  const x = decimalTo32BytesBE(pi_a[0]);
  const negY = decimalTo32BytesBE(negateY(pi_a[1]));
  const result = new Uint8Array(64);
  result.set(x, 0);
  result.set(negY, 32);
  return result;
}

/**
 * Convert snarkjs proof_b (G2 affine point) to 128 bytes.
 *
 * G2 points have two Fp2 elements (x, y), each being (c0, c1).
 * snarkjs format: pi_b = [[x_c0, x_c1], [y_c0, y_c1], [z_c0, z_c1]]
 *
 * groth16-solana expects: [x_c1(32) | x_c0(32) | y_c1(32) | y_c0(32)]
 * Note: c0 and c1 are SWAPPED compared to snarkjs ordering.
 */
export function encodeProofB(pi_b: SnarkjsProof["pi_b"]): Uint8Array {
  const result = new Uint8Array(128);
  // x component: swap c0/c1
  result.set(decimalTo32BytesBE(pi_b[0][1]), 0); // x_c1
  result.set(decimalTo32BytesBE(pi_b[0][0]), 32); // x_c0
  // y component: swap c0/c1
  result.set(decimalTo32BytesBE(pi_b[1][1]), 64); // y_c1
  result.set(decimalTo32BytesBE(pi_b[1][0]), 96); // y_c0
  return result;
}

/**
 * Convert snarkjs proof_c (G1 affine point) to 64 bytes [x(32) | y(32)].
 * No negation needed for proof_c.
 */
export function encodeProofC(pi_c: SnarkjsProof["pi_c"]): Uint8Array {
  const x = decimalTo32BytesBE(pi_c[0]);
  const y = decimalTo32BytesBE(pi_c[1]);
  const result = new Uint8Array(64);
  result.set(x, 0);
  result.set(y, 32);
  return result;
}

/**
 * Convert the 4 public signals to [[u8; 32]; 4] format.
 * Order: [tier_lower_bound, tier_upper_bound, nullifier, timestamp]
 */
export function encodePublicInputs(publicSignals: PublicSignals): Uint8Array[] {
  return publicSignals.map((s) => decimalTo32BytesBE(s));
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the TierBadge PDA address for a given user.
 * Seeds: ["tier_badge", user_pubkey]
 */
export function deriveTierBadgePDA(
  userPubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TIER_BADGE_SEED, userPubkey.toBuffer()],
    programId,
  );
}

// ---------------------------------------------------------------------------
// Tier decoding
// ---------------------------------------------------------------------------

/** Decode tier number from lower/upper bounds (in USD cents) */
export function decodeTier(
  tierLower: bigint,
  tierUpper: bigint,
): number | null {
  const tiers: [bigint, bigint, number][] = [
    [0n, 100_000n, 1], // Seed: <$1K
    [100_000n, 1_000_000n, 2], // Sprout: $1K-$10K
    [1_000_000n, 5_000_000n, 3], // Tree: $10K-$50K
    [5_000_000n, 25_000_000n, 4], // Mountain: $50K-$250K
    [25_000_000n, 100_000_000n, 5], // Ocean: $250K-$1M
    [100_000_000n, 500_000_000n, 6], // Moon: $1M-$5M
    [500_000_000n, 10_000_000_000_000n, 7], // Sun: $5M+
  ];
  for (const [lo, hi, tier] of tiers) {
    if (tierLower === lo && tierUpper === hi) return tier;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IDL type definition (minimal, just the verify_and_store_tier instruction)
// ---------------------------------------------------------------------------

/**
 * Minimal IDL for the proof_of_love program.
 * Only includes what we need to call verify_and_store_tier.
 */
export const PROOF_OF_LOVE_IDL = {
  version: "0.1.0",
  name: "proof_of_love",
  instructions: [
    {
      name: "verifyAndStoreTier",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "tierBadge", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "proofA", type: { array: ["u8", 64] } },
        { name: "proofB", type: { array: ["u8", 128] } },
        { name: "proofC", type: { array: ["u8", 64] } },
        {
          name: "publicInputs",
          type: { array: [{ array: ["u8", 32] }, 4] },
        },
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Instruction builder
// ---------------------------------------------------------------------------

/**
 * Build the Anchor instruction for verify_and_store_tier.
 *
 * This is the low-level builder — use this in browser contexts where you
 * want to send the transaction through a wallet adapter.
 */
export function buildVerifyInstruction(opts: BuildInstructionOptions): {
  instruction: TransactionInstruction;
  tierBadgePDA: PublicKey;
  tierBadgeBump: number;
} {
  const programId = opts.programId ?? PROGRAM_ID;
  const { proof, publicSignals, userPubkey } = opts;

  // 1. Encode proof components
  const proofA = encodeProofA(proof.pi_a);
  const proofB = encodeProofB(proof.pi_b);
  const proofC = encodeProofC(proof.pi_c);
  const pubInputs = encodePublicInputs(publicSignals);

  // 2. Derive PDA
  const [tierBadgePDA, tierBadgeBump] = deriveTierBadgePDA(
    userPubkey,
    programId,
  );

  // 3. Build the instruction data manually using Anchor's discriminator
  //    Discriminator = first 8 bytes of sha256("global:verify_and_store_tier")
  const disc = createHash("sha256")
    .update("global:verify_and_store_tier")
    .digest()
    .subarray(0, 8);

  // Instruction data layout:
  // [8 disc | 64 proof_a | 128 proof_b | 64 proof_c | 4*32 public_inputs]
  const dataLen = 8 + 64 + 128 + 64 + 4 * 32;
  const data = Buffer.alloc(dataLen);
  let offset = 0;

  disc.copy(data, offset);
  offset += 8;

  Buffer.from(proofA).copy(data, offset);
  offset += 64;

  Buffer.from(proofB).copy(data, offset);
  offset += 128;

  Buffer.from(proofC).copy(data, offset);
  offset += 64;

  for (const input of pubInputs) {
    Buffer.from(input).copy(data, offset);
    offset += 32;
  }

  // 4. Build the instruction
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: tierBadgePDA, isSigner: false, isWritable: true },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });

  return { instruction, tierBadgePDA, tierBadgeBump };
}

// ---------------------------------------------------------------------------
// Full submit flow (Node.js / CLI usage with Keypair)
// ---------------------------------------------------------------------------

/**
 * Submit a Groth16 proof to the on-chain verifier.
 *
 * Full flow: encode proof → build instruction → send transaction.
 *
 * @example
 * ```ts
 * import { submitProofToSolana } from './solana-submitter';
 * import { Keypair, Connection } from '@solana/web3.js';
 *
 * const wallet = Keypair.fromSecretKey(...);
 * const connection = new Connection('http://localhost:8899');
 *
 * const result = await submitProofToSolana({
 *   proof,        // from snarkjs.groth16.fullProve()
 *   publicSignals, // [tierLower, tierUpper, nullifier, timestamp]
 *   wallet,
 *   connection,
 * });
 *
 * console.log('TX:', result.txSignature);
 * console.log('Tier:', result.tier);
 * console.log('Badge PDA:', result.tierBadgePDA.toBase58());
 * ```
 */
export async function submitProofToSolana(
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const {
    proof,
    publicSignals,
    wallet,
    connection,
    programId,
    skipPreflight = false,
  } = opts;

  // Build instruction
  const { instruction, tierBadgePDA } = buildVerifyInstruction({
    proof,
    publicSignals,
    userPubkey: wallet.publicKey,
    programId,
  });

  // Build and send transaction
  const tx = new Transaction().add(instruction);
  tx.feePayer = wallet.publicKey;

  const txSignature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet],
    {
      skipPreflight,
      commitment: "confirmed",
    },
  );

  // Decode tier from public signals
  const tierLower = BigInt(publicSignals[0]);
  const tierUpper = BigInt(publicSignals[1]);
  const tier = decodeTier(tierLower, tierUpper) ?? 0;

  return {
    txSignature,
    tierBadgePDA,
    tier,
  };
}

// ---------------------------------------------------------------------------
// Browser-friendly helper (for wallet adapter integration)
// ---------------------------------------------------------------------------

/**
 * Prepare a transaction for browser wallet signing.
 *
 * Returns a Transaction object that can be signed and sent via
 * @solana/wallet-adapter-react's `sendTransaction`.
 *
 * @example
 * ```tsx
 * // In a React component with useWallet() and useConnection()
 * import { prepareVerifyTransaction } from './solana-submitter';
 *
 * const { publicKey, sendTransaction } = useWallet();
 * const { connection } = useConnection();
 *
 * const { transaction, tierBadgePDA } = await prepareVerifyTransaction({
 *   proof,
 *   publicSignals,
 *   userPubkey: publicKey,
 *   connection,
 * });
 *
 * const sig = await sendTransaction(transaction, connection);
 * ```
 */
export async function prepareVerifyTransaction(opts: {
  proof: SnarkjsProof;
  publicSignals: PublicSignals;
  userPubkey: PublicKey;
  connection: Connection;
  programId?: PublicKey;
}): Promise<{ transaction: Transaction; tierBadgePDA: PublicKey }> {
  const { proof, publicSignals, userPubkey, connection, programId } = opts;

  const { instruction, tierBadgePDA } = buildVerifyInstruction({
    proof,
    publicSignals,
    userPubkey,
    programId,
  });

  const tx = new Transaction().add(instruction);
  tx.feePayer = userPubkey;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;

  return { transaction: tx, tierBadgePDA };
}
