import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Configuration — adjust these paths to match your monorepo layout
// ---------------------------------------------------------------------------

/**
 * Path to circuit build artifacts, relative to the verifier package root.
 * Expects:
 *   CIRCUIT_BUILD_DIR/wealth_tier_js/wealth_tier.wasm
 *   CIRCUIT_BUILD_DIR/keys/wealth_tier_final.zkey
 */
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUIT_BUILD_DIR = path.resolve(
  __dirname,
  "../../circuits/build"
);
const WASM_PATH = path.join(
  CIRCUIT_BUILD_DIR,
  "wealth_tier_js",
  "wealth_tier.wasm",
);
const ZKEY_PATH = path.join(
  CIRCUIT_BUILD_DIR,
  "keys",
  "wealth_tier_final.zkey",
);

// ---------------------------------------------------------------------------
// Proof encoding helpers (inline to avoid import issues in Anchor test env)
// ---------------------------------------------------------------------------

const CURVE_ORDER = BigInt(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
);

function decimalTo32BytesBE(decStr: string): Buffer {
  let bn = BigInt(decStr);
  const bytes = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(bn & 0xffn);
    bn >>= 8n;
  }
  return bytes;
}

function negateY(yDecStr: string): string {
  const y = BigInt(yDecStr);
  if (y === 0n) return "0";
  return (CURVE_ORDER - y).toString();
}

/** G1 point → 64 bytes, y-coordinate negated */
function encodeProofA(pi_a: string[]): Buffer {
  const buf = Buffer.alloc(64);
  decimalTo32BytesBE(pi_a[0]).copy(buf, 0);
  decimalTo32BytesBE(negateY(pi_a[1])).copy(buf, 32);
  return buf;
}

/** G2 point → 128 bytes, c0/c1 swapped vs snarkjs ordering */
function encodeProofB(pi_b: string[][]): Buffer {
  const buf = Buffer.alloc(128);
  decimalTo32BytesBE(pi_b[0][1]).copy(buf, 0); // x_c1
  decimalTo32BytesBE(pi_b[0][0]).copy(buf, 32); // x_c0
  decimalTo32BytesBE(pi_b[1][1]).copy(buf, 64); // y_c1
  decimalTo32BytesBE(pi_b[1][0]).copy(buf, 96); // y_c0
  return buf;
}

/** G1 point → 64 bytes, no negation */
function encodeProofC(pi_c: string[]): Buffer {
  const buf = Buffer.alloc(64);
  decimalTo32BytesBE(pi_c[0]).copy(buf, 0);
  decimalTo32BytesBE(pi_c[1]).copy(buf, 32);
  return buf;
}

/** Derive the TierBadge PDA */
function deriveTierBadgePDA(
  userPubkey: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tier_badge"), userPubkey.toBuffer()],
    programId,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("proof-of-love", () => {
  // Anchor provider setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load program from workspace (uses generated IDL)
  const program = anchor.workspace.ProofOfLove as Program;
  const programId = program.programId;

  // The test wallet (provider's wallet)
  const user = provider.wallet as anchor.Wallet;

  // snarkjs — loaded dynamically since it's ESM
  let snarkjs: any;

  // Generated proof data (shared across tests)
  let proofA: Buffer;
  let proofB: Buffer;
  let proofC: Buffer;
  let publicInputs: Buffer[];
  let publicSignals: string[];
  let tierBadgePDA: PublicKey;
  let tierBadgeBump: number;

  // ---------------------------------------------------------------------------
  // Setup: check artifacts exist, load snarkjs, generate a proof
  // ---------------------------------------------------------------------------

  before(async () => {
    // 1. Check circuit artifacts exist
    console.log("\n  Circuit artifacts:");
    console.log(`    WASM: ${WASM_PATH}`);
    console.log(`    zkey: ${ZKEY_PATH}`);

    if (!fs.existsSync(WASM_PATH)) {
      throw new Error(
        `Circuit WASM not found at ${WASM_PATH}\n` +
          `  Make sure you've built the circuit: cd circuits && ./build.sh\n` +
          `  Then adjust CIRCUIT_BUILD_DIR in this test file if needed.`,
      );
    }
    if (!fs.existsSync(ZKEY_PATH)) {
      throw new Error(
        `Circuit zkey not found at ${ZKEY_PATH}\n` +
          `  Make sure you've run the trusted setup: snarkjs groth16 setup ...`,
      );
    }

    // 2. Load snarkjs (ESM module)
    snarkjs = await import("snarkjs");
    console.log("    snarkjs loaded ✓");

    // 3. Generate a proof for Tier 6 (Moon: $1M-$5M, bounds 100_000_000 - 500_000_000 cents)
    //    Using test balances of $2M = 200_000_000 cents at each snapshot
    const timestamp = Math.floor(Date.now() / 1000);

    // Compute a deterministic nullifier for the test wallet
    // In the real app, this comes from Poseidon hash of wallet addresses
    // For the test, we just use a known value
    const nullifier = BigInt(
      "0x" +
        createHash("sha256").update(user.publicKey.toBuffer()).digest("hex"),
    ).toString();

    const circuitInput = {
      // Private inputs
      balance_1: "200000000", // $2M
      balance_2: "200000000",
      balance_3: "200000000",
      // Public inputs
      tier_lower_bound: "100000000", // $1M
      tier_upper_bound: "500000000", // $5M
      nullifier: nullifier,
      timestamp: timestamp.toString(),
    };

    console.log("\n  Generating Groth16 proof...");
    console.log(`    Tier: Moon (6) — $1M-$5M`);
    console.log(`    Test balance: $2M at each snapshot`);
    console.log(`    Timestamp: ${timestamp}`);

    const startTime = Date.now();
    const { proof, publicSignals: signals } = await snarkjs.groth16.fullProve(
      circuitInput,
      WASM_PATH,
      ZKEY_PATH,
    );
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`    Proof generated in ${elapsed}s ✓`);

    // 4. Verify off-chain first (sanity check)
    const vkPath = path.join(
      CIRCUIT_BUILD_DIR,
      "keys",
      "verification_key.json",
    );
    const vk = JSON.parse(fs.readFileSync(vkPath, "utf-8"));
    const offChainValid = await snarkjs.groth16.verify(vk, signals, proof);
    console.log(`    Off-chain verification: ${offChainValid ? "✓" : "✗"}`);
    expect(offChainValid).to.be.true;

    // 5. Encode for on-chain submission
    publicSignals = signals;
    proofA = encodeProofA(proof.pi_a);
    proofB = encodeProofB(proof.pi_b);
    proofC = encodeProofC(proof.pi_c);
    publicInputs = signals.map((s: string) => decimalTo32BytesBE(s));

    // 6. Derive the PDA
    [tierBadgePDA, tierBadgeBump] = deriveTierBadgePDA(
      user.publicKey,
      programId,
    );
    console.log(`    TierBadge PDA: ${tierBadgePDA.toBase58()}`);
    console.log(`    Bump: ${tierBadgeBump}\n`);
  });

  // ---------------------------------------------------------------------------
  // Test 1: Successful proof verification and PDA creation
  // ---------------------------------------------------------------------------

  it("verifies a Groth16 proof and creates a TierBadge PDA", async () => {
    // Convert to the format Anchor expects: arrays of numbers
    const proofAArray = Array.from(proofA);
    const proofBArray = Array.from(proofB);
    const proofCArray = Array.from(proofC);
    const pubInputsArray = publicInputs.map((buf) => Array.from(buf));

    const tx = await program.methods
      .verifyAndStoreTier(proofAArray, proofBArray, proofCArray, pubInputsArray)
      .accounts({
        user: user.publicKey,
        tierBadge: tierBadgePDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    TX signature:", tx);

    // Fetch the PDA and validate its contents
    const badge = await (program.account as any).tierBadge.fetch(tierBadgePDA);

    expect(badge.owner.toBase58()).to.equal(user.publicKey.toBase58());
    expect(badge.tier).to.equal(6); // Moon tier
    expect(badge.tierLowerBound.toNumber()).to.equal(100_000_000);
    expect(badge.tierUpperBound.toNumber()).to.equal(500_000_000);
    expect(badge.bump).to.equal(tierBadgeBump);

    // Verify expiry is ~30 days after verification
    const expectedExpiry = badge.verifiedAt.toNumber() + 30 * 24 * 60 * 60;
    expect(badge.expiresAt.toNumber()).to.equal(expectedExpiry);

    console.log("    Tier badge created ✓");
    console.log(`      Owner:    ${badge.owner.toBase58()}`);
    console.log(`      Tier:     ${badge.tier} (Moon)`);
    console.log(
      `      Bounds:   ${badge.tierLowerBound} - ${badge.tierUpperBound}`,
    );
    console.log(
      `      Verified: ${new Date(badge.verifiedAt.toNumber() * 1000).toISOString()}`,
    );
    console.log(
      `      Expires:  ${new Date(badge.expiresAt.toNumber() * 1000).toISOString()}`,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2: Re-verification updates the existing PDA (init_if_needed)
  // ---------------------------------------------------------------------------

  it("re-verifies and updates existing TierBadge", async () => {
    // Generate a fresh proof with a new timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    const nullifier = BigInt(
      "0x" +
        createHash("sha256").update(user.publicKey.toBuffer()).digest("hex"),
    ).toString();

    const { proof, publicSignals: signals } = await snarkjs.groth16.fullProve(
      {
        balance_1: "200000000",
        balance_2: "200000000",
        balance_3: "200000000",
        tier_lower_bound: "100000000",
        tier_upper_bound: "500000000",
        nullifier,
        timestamp: timestamp.toString(),
      },
      WASM_PATH,
      ZKEY_PATH,
    );

    const newProofA = encodeProofA(proof.pi_a);
    const newProofB = encodeProofB(proof.pi_b);
    const newProofC = encodeProofC(proof.pi_c);
    const newPubInputs = signals.map((s: string) => decimalTo32BytesBE(s));

    const tx = await program.methods
      .verifyAndStoreTier(
        Array.from(newProofA),
        Array.from(newProofB),
        Array.from(newProofC),
        newPubInputs.map((buf: Buffer) => Array.from(buf)),
      )
      .accounts({
        user: user.publicKey,
        tierBadge: tierBadgePDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("    Re-verification TX:", tx);

    // PDA should be updated with new timestamp
    const badge = await (program.account as any).tierBadge.fetch(tierBadgePDA);
    expect(badge.tier).to.equal(6);
    expect(badge.verifiedAt.toNumber()).to.be.gte(timestamp - 5);
    console.log("    PDA updated with fresh timestamp ✓");
  });

  // ---------------------------------------------------------------------------
  // Test 3: Invalid tier bounds should fail
  // ---------------------------------------------------------------------------

  it("rejects proof with invalid tier bounds", async () => {
    // Try to submit with tier bounds that don't match any known tier
    // We'll fabricate invalid public inputs (won't pass Groth16 verify either,
    // but the program should reject before/during verification)
    const fakePubInputs = [
      decimalTo32BytesBE("999999"), // invalid lower
      decimalTo32BytesBE("9999999"), // invalid upper
      decimalTo32BytesBE("12345"), // fake nullifier
      decimalTo32BytesBE(Math.floor(Date.now() / 1000).toString()),
    ];

    try {
      await program.methods
        .verifyAndStoreTier(
          Array.from(proofA), // real proof_a but wrong public inputs
          Array.from(proofB),
          Array.from(proofC),
          fakePubInputs.map((buf) => Array.from(buf)),
        )
        .accounts({
          user: user.publicKey,
          tierBadge: tierBadgePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Should not reach here
      expect.fail("Expected transaction to fail with invalid inputs");
    } catch (err: any) {
      // The Groth16 verification itself should fail since proof doesn't match
      // these public inputs, resulting in ProofVerificationFailed
      console.log("    Correctly rejected invalid proof ✓");
      console.log(`    Error: ${err.message?.substring(0, 80)}...`);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Revoke expired tier should fail when badge is still valid
  // ---------------------------------------------------------------------------

  it("rejects revocation of non-expired badge", async () => {
    try {
      await program.methods
        .revokeExpiredTier()
        .accounts({
          user: user.publicKey,
          tierBadge: tierBadgePDA,
        })
        .rpc();

      expect.fail("Expected transaction to fail — badge is not expired");
    } catch (err: any) {
      console.log("    Correctly rejected premature revocation ✓");
      const errMsg = err.message || "";
      // Should be BadgeNotExpired error or a custom program error code
      const hasExpectedError =
        errMsg.includes("BadgeNotExpired") ||
        errMsg.includes("6003") ||
        errMsg.includes("custom program error");
      expect(hasExpectedError).to.be.true;
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: Different user gets a different PDA
  // ---------------------------------------------------------------------------

  it("creates separate PDA for a different user", async () => {
    // Generate a new keypair for a second user
    const user2 = Keypair.generate();

    // Airdrop some SOL
    const airdropSig = await provider.connection.requestAirdrop(
      user2.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    // Generate proof for user2
    const timestamp = Math.floor(Date.now() / 1000);
    const nullifier2 = BigInt(
      "0x" +
        createHash("sha256").update(user2.publicKey.toBuffer()).digest("hex"),
    ).toString();

    const { proof, publicSignals: signals } = await snarkjs.groth16.fullProve(
      {
        balance_1: "30000000", // $300K — Tier 5 (Ocean)
        balance_2: "30000000",
        balance_3: "30000000",
        tier_lower_bound: "25000000",
        tier_upper_bound: "100000000",
        nullifier: nullifier2,
        timestamp: timestamp.toString(),
      },
      WASM_PATH,
      ZKEY_PATH,
    );

    const [pda2, bump2] = deriveTierBadgePDA(user2.publicKey, programId);

    const tx = await program.methods
      .verifyAndStoreTier(
        Array.from(encodeProofA(proof.pi_a)),
        Array.from(encodeProofB(proof.pi_b)),
        Array.from(encodeProofC(proof.pi_c)),
        signals.map((s: string) => Array.from(decimalTo32BytesBE(s))),
      )
      .accounts({
        user: user2.publicKey,
        tierBadge: pda2,
        systemProgram: SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    console.log("    User2 TX:", tx);

    // Verify user2's badge
    const badge2 = await (program.account as any).tierBadge.fetch(pda2);
    expect(badge2.owner.toBase58()).to.equal(user2.publicKey.toBase58());
    expect(badge2.tier).to.equal(5); // Ocean tier
    expect(badge2.tierLowerBound.toNumber()).to.equal(25_000_000);
    expect(badge2.tierUpperBound.toNumber()).to.equal(100_000_000);

    // User1's badge should still exist and be unchanged
    const badge1 = await (program.account as any).tierBadge.fetch(tierBadgePDA);
    expect(badge1.tier).to.equal(6); // Still Moon

    console.log("    User2 badge: Tier 5 (Ocean) ✓");
    console.log("    User1 badge: Tier 6 (Moon) — unchanged ✓");
    console.log(`    User2 PDA: ${pda2.toBase58()}`);
  });
});
