const path = require("path");
const wasm_tester = require("circom_tester").wasm;
const assert = require("chai").assert;

describe("WealthTier Circuit (AVG)", function () {
  let circuit;

  // Tier definitions (in cents)
  const TIERS = {
    1: { lower: 0, upper: 100_000 }, // Seed: < $1K
    2: { lower: 100_000, upper: 1_000_000 }, // Sprout: $1K - $10K
    3: { lower: 1_000_000, upper: 5_000_000 }, // Tree: $10K - $50K
    4: { lower: 5_000_000, upper: 25_000_000 }, // Mountain: $50K - $250K
    5: { lower: 25_000_000, upper: 100_000_000 }, // Ocean: $250K - $1M
    6: { lower: 100_000_000, upper: 500_000_000 }, // Moon: $1M - $5M
    7: { lower: 500_000_000, upper: "10000000000000000" }, // Sun: $5M+ (MAX_BALANCE = 10^16)
  };

  // Helper: compute floor average of 3 values
  function avg3(a, b, c) {
    return Math.floor((a + b + c) / 3);
  }

  before(async () => {
    console.log("Loading circuit...");
    circuit = await wasm_tester(
      path.join(__dirname, "../circom/wealth_tier.circom"),
      {
        output: path.join(__dirname, "../build/test"),
        recompile: true,
      },
    );
    console.log("Circuit loaded successfully");
  });

  describe("Tier 1: Seed (< $1K)", function () {
    it("Should generate valid proof for $500 avg balance in Tier 1", async () => {
      // avg(50000, 60000, 55000) = 55000 → Tier 1
      const input = {
        balance_1: "50000", // $500
        balance_2: "60000", // $600
        balance_3: "55000", // $550
        tier_lower_bound: TIERS[1].lower.toString(),
        tier_upper_bound: TIERS[1].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should fail for avg balance above Tier 1", async () => {
      // avg(150000, 160000, 155000) = 155000 → above $1K
      const input = {
        balance_1: "150000", // $1,500
        balance_2: "160000",
        balance_3: "155000",
        tier_lower_bound: TIERS[1].lower.toString(),
        tier_upper_bound: TIERS[1].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      try {
        await circuit.calculateWitness(input);
        assert.fail("Should have thrown an error");
      } catch (error) {
        assert.include(error.message.toLowerCase(), "assert");
      }
    });
  });

  describe("Tier 4: Mountain ($50K - $250K)", function () {
    it("Should generate valid proof for $120K avg balance in Tier 4", async () => {
      // avg(10000000, 15000000, 12000000) = 12333333 → $123,333 → Tier 4
      const input = {
        balance_1: "10000000", // $100K
        balance_2: "15000000", // $150K
        balance_3: "12000000", // $120K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should PASS with AVG even if one month dips (unlike MIN)", async () => {
      // This is the key difference from MIN!
      // avg(10000000, 3000000, 12000000) = 8333333 → $83,333 → Tier 4 ✓
      // Under MIN logic this would have been $30K → Tier 3 ✗
      const input = {
        balance_1: "10000000", // $100K
        balance_2: "3000000", // $30K (dip!)
        balance_3: "12000000", // $120K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const a = avg3(10000000, 3000000, 12000000);
      assert.isAtLeast(a, TIERS[4].lower, "avg should be >= tier lower bound");

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should fail if avg balance below tier", async () => {
      // avg(3000000, 2000000, 1000000) = 2000000 → $20K → Tier 3, not 4
      const input = {
        balance_1: "3000000", // $30K
        balance_2: "2000000", // $20K
        balance_3: "1000000", // $10K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      try {
        await circuit.calculateWitness(input);
        assert.fail("Should have thrown an error");
      } catch (error) {
        assert.include(error.message.toLowerCase(), "assert");
      }
    });

    it("Should fail if avg balance above tier", async () => {
      // avg(30000000, 35000000, 32000000) = 32333333 → $323K → Tier 5, not 4
      const input = {
        balance_1: "30000000", // $300K
        balance_2: "35000000", // $350K
        balance_3: "32000000", // $320K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      try {
        await circuit.calculateWitness(input);
        assert.fail("Should have thrown an error");
      } catch (error) {
        assert.include(error.message.toLowerCase(), "assert");
      }
    });
  });

  describe("Tier 7: Sun ($5M+)", function () {
    it("Should generate valid proof for $11M avg balance in Tier 7", async () => {
      // avg(1000000000, 1200000000, 1100000000) = 1100000000 → $11M
      const input = {
        balance_1: "1000000000", // $10M
        balance_2: "1200000000", // $12M
        balance_3: "1100000000", // $11M
        tier_lower_bound: TIERS[7].lower.toString(),
        tier_upper_bound: TIERS[7].upper, // MAX_BALANCE = 10^16
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should fail for $3M avg balance in Tier 7 (below $5M)", async () => {
      // avg(300000000, 320000000, 310000000) = 310000000 → $3.1M
      const input = {
        balance_1: "300000000", // $3M
        balance_2: "320000000",
        balance_3: "310000000",
        tier_lower_bound: TIERS[7].lower.toString(),
        tier_upper_bound: TIERS[7].upper,
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      try {
        await circuit.calculateWitness(input);
        assert.fail("Should have thrown an error");
      } catch (error) {
        assert.include(error.message.toLowerCase(), "assert");
      }
    });
  });

  describe("Average Balance Logic", function () {
    it("Should use average (not min) of 3 balances", async () => {
      // avg(5000000, 10000000, 15000000) = 10000000 → $100K → Tier 4
      const input = {
        balance_1: "5000000", // $50K
        balance_2: "10000000", // $100K
        balance_3: "15000000", // $150K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should handle equal balances", async () => {
      // avg(10000000, 10000000, 10000000) = 10000000 → $100K → Tier 4
      const input = {
        balance_1: "10000000",
        balance_2: "10000000",
        balance_3: "10000000",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should handle remainder correctly (sum not divisible by 3)", async () => {
      // avg(5000001, 5000001, 5000001) = 5000001 → $50K → Tier 4
      // sum = 15000003, avg = 5000001, remainder = 0 (clean)
      const input = {
        balance_1: "5000001",
        balance_2: "5000001",
        balance_3: "5000001",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should handle remainder = 1 correctly", async () => {
      // sum = 15000001, avg = 5000000, remainder = 1
      const input = {
        balance_1: "5000000",
        balance_2: "5000000",
        balance_3: "5000001",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should handle remainder = 2 correctly", async () => {
      // sum = 15000002, avg = 5000000, remainder = 2
      const input = {
        balance_1: "5000000",
        balance_2: "5000001",
        balance_3: "5000001",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should allow a big temporary dip if avg stays in tier", async () => {
      // One month at $10K, two months at $200K
      // avg(1000000, 20000000, 20000000) = 13666666 → $136K → Tier 4 ✓
      const input = {
        balance_1: "1000000", // $10K (big dip)
        balance_2: "20000000", // $200K
        balance_3: "20000000", // $200K
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const a = avg3(1000000, 20000000, 20000000);
      assert.isAtLeast(a, TIERS[4].lower);
      assert.isBelow(a, TIERS[4].upper);

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle exact boundary (lower bound)", async () => {
      // avg = exactly $50K = 5000000 cents → Tier 4 (>= lower)
      const input = {
        balance_1: "5000000",
        balance_2: "5000000",
        balance_3: "5000000",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should fail at exact upper boundary", async () => {
      // avg = exactly $250K = 25000000 cents → NOT Tier 4 (< upper fails)
      const input = {
        balance_1: "25000000",
        balance_2: "25000000",
        balance_3: "25000000",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      try {
        await circuit.calculateWitness(input);
        assert.fail("Should have thrown an error");
      } catch (error) {
        assert.include(error.message.toLowerCase(), "assert");
      }
    });

    it("Should handle zero balance (Tier 1)", async () => {
      const input = {
        balance_1: "0",
        balance_2: "0",
        balance_3: "0",
        tier_lower_bound: TIERS[1].lower.toString(),
        tier_upper_bound: TIERS[1].upper.toString(),
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });

    it("Should handle very large balances (Tier 7)", async () => {
      const input = {
        balance_1: "10000000000000", // $100 billion
        balance_2: "12000000000000",
        balance_3: "11000000000000",
        tier_lower_bound: TIERS[7].lower.toString(),
        tier_upper_bound: TIERS[7].upper,
        nullifier: "123456789",
        timestamp: "1708329600",
      };

      const witness = await circuit.calculateWitness(input);
      await circuit.checkConstraints(witness);
    });
  });

  describe("Nullifier and Timestamp Binding", function () {
    it("Should accept different nullifiers for same balance", async () => {
      const baseInput = {
        balance_1: "10000000",
        balance_2: "15000000",
        balance_3: "12000000",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        timestamp: "1708329600",
      };

      const input1 = { ...baseInput, nullifier: "111111111" };
      const witness1 = await circuit.calculateWitness(input1);
      await circuit.checkConstraints(witness1);

      const input2 = { ...baseInput, nullifier: "222222222" };
      const witness2 = await circuit.calculateWitness(input2);
      await circuit.checkConstraints(witness2);
    });

    it("Should accept different timestamps for same balance", async () => {
      const baseInput = {
        balance_1: "10000000",
        balance_2: "15000000",
        balance_3: "12000000",
        tier_lower_bound: TIERS[4].lower.toString(),
        tier_upper_bound: TIERS[4].upper.toString(),
        nullifier: "123456789",
      };

      const input1 = { ...baseInput, timestamp: "1708329600" };
      const witness1 = await circuit.calculateWitness(input1);
      await circuit.checkConstraints(witness1);

      const input2 = { ...baseInput, timestamp: "1711008000" };
      const witness2 = await circuit.calculateWitness(input2);
      await circuit.checkConstraints(witness2);
    });
  });
});
