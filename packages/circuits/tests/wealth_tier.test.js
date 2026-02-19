const path = require("path");
const wasm_tester = require("circom_tester").wasm;
const assert = require("chai").assert;

describe("WealthTier Circuit", function() {
    let circuit;

    // Tier definitions (in cents)
    const TIERS = {
        1: { lower: 0, upper: 100_000 },          // Seed: < $1K
        2: { lower: 100_000, upper: 1_000_000 },  // Sprout: $1K - $10K
        3: { lower: 1_000_000, upper: 5_000_000 },// Tree: $10K - $50K
        4: { lower: 5_000_000, upper: 25_000_000 },// Mountain: $50K - $250K
        5: { lower: 25_000_000, upper: 100_000_000 },// Ocean: $250K - $1M
        6: { lower: 100_000_000, upper: 500_000_000 },// Moon: $1M - $5M
        7: { lower: 500_000_000, upper: "10000000000000000" }// Sun: $5M+ (MAX_BALANCE = 10^16)
    };

    before(async () => {
        console.log("Loading circuit...");
        circuit = await wasm_tester(
            path.join(__dirname, "../circom/wealth_tier.circom"),
            {
                output: path.join(__dirname, "../build/test"),
                recompile: true
            }
        );
        console.log("Circuit loaded successfully");
    });

    describe("Tier 1: Seed (< $1K)", function() {
        it("Should generate valid proof for $500 balance in Tier 1", async () => {
            const input = {
                balance_1: "50000",  // $500
                balance_2: "60000",  // $600
                balance_3: "55000",  // $550
                tier_lower_bound: TIERS[1].lower.toString(),
                tier_upper_bound: TIERS[1].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should fail to generate proof for $1,500 balance in Tier 1 (too high)", async () => {
            const input = {
                balance_1: "150000",  // $1,500
                balance_2: "160000",
                balance_3: "155000",
                tier_lower_bound: TIERS[1].lower.toString(),
                tier_upper_bound: TIERS[1].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            try {
                await circuit.calculateWitness(input);
                assert.fail("Should have thrown an error");
            } catch (error) {
                // Expected - proof generation should fail when hard constraint isn't satisfied
                assert.include(error.message.toLowerCase(), "assert");
            }
        });
    });

    describe("Tier 4: Mountain ($50K - $250K)", function() {
        it("Should generate valid proof for $100K balance in Tier 4", async () => {
            const input = {
                balance_1: "10000000",  // $100K
                balance_2: "15000000",  // $150K
                balance_3: "12000000",  // $120K
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should fail if minimum balance below tier ($30K min)", async () => {
            const input = {
                balance_1: "10000000",  // $100K
                balance_2: "3000000",   // $30K (below $50K minimum)
                balance_3: "12000000",  // $120K
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            try {
                await circuit.calculateWitness(input);
                assert.fail("Should have thrown an error");
            } catch (error) {
                assert.include(error.message.toLowerCase(), "assert");
            }
        });

        it("Should fail if minimum balance above tier ($300K min)", async () => {
            const input = {
                balance_1: "30000000",  // $300K (above $250K max)
                balance_2: "35000000",  // $350K
                balance_3: "32000000",  // $320K
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            try {
                await circuit.calculateWitness(input);
                assert.fail("Should have thrown an error");
            } catch (error) {
                assert.include(error.message.toLowerCase(), "assert");
            }
        });
    });

    describe("Tier 7: Sun ($5M+)", function() {
        it("Should generate valid proof for $10M balance in Tier 7", async () => {
            const input = {
                balance_1: "1000000000",  // $10M
                balance_2: "1200000000",  // $12M
                balance_3: "1100000000",  // $11M
                tier_lower_bound: TIERS[7].lower.toString(),
                tier_upper_bound: TIERS[7].upper,  // MAX_BALANCE = 10^16
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should fail for $3M balance in Tier 7 (below $5M)", async () => {
            const input = {
                balance_1: "300000000",  // $3M
                balance_2: "320000000",
                balance_3: "310000000",
                tier_lower_bound: TIERS[7].lower.toString(),
                tier_upper_bound: TIERS[7].upper,
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            try {
                await circuit.calculateWitness(input);
                assert.fail("Should have thrown an error");
            } catch (error) {
                assert.include(error.message.toLowerCase(), "assert");
            }
        });
    });

    describe("Minimum Balance Logic", function() {
        it("Should use minimum of 3 balances (case: min is first)", async () => {
            const input = {
                balance_1: "5000000",   // $50K - minimum
                balance_2: "10000000",  // $100K
                balance_3: "8000000",   // $80K
                tier_lower_bound: TIERS[4].lower.toString(),  // Tier 4
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should use minimum of 3 balances (case: min is second)", async () => {
            const input = {
                balance_1: "10000000",  // $100K
                balance_2: "5000000",   // $50K - minimum
                balance_3: "8000000",   // $80K
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should use minimum of 3 balances (case: min is third)", async () => {
            const input = {
                balance_1: "10000000",  // $100K
                balance_2: "8000000",   // $80K
                balance_3: "5000000",   // $50K - minimum
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should fail when one balance dips below tier (flash loan prevention)", async () => {
            const input = {
                balance_1: "10000000",  // $100K
                balance_2: "100000",    // $1K (dip below tier)
                balance_3: "12000000",  // $120K
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            try {
                await circuit.calculateWitness(input);
                assert.fail("Should have thrown an error");
            } catch (error) {
                assert.include(error.message.toLowerCase(), "assert");
            }
        });
    });

    describe("Edge Cases", function() {
        it("Should handle exact boundary (lower bound)", async () => {
            const input = {
                balance_1: "5000000",  // Exactly $50K
                balance_2: "5000000",
                balance_3: "5000000",
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should fail at exact upper boundary", async () => {
            const input = {
                balance_1: "25000000",  // Exactly $250K (upper bound)
                balance_2: "25000000",
                balance_3: "25000000",
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                nullifier: "123456789",
                timestamp: "1708329600"
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
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });

        it("Should handle very large balances (Tier 7)", async () => {
            const input = {
                balance_1: "10000000000000",  // $100 billion
                balance_2: "12000000000000",
                balance_3: "11000000000000",
                tier_lower_bound: TIERS[7].lower.toString(),
                tier_upper_bound: TIERS[7].upper,
                nullifier: "123456789",
                timestamp: "1708329600"
            };

            const witness = await circuit.calculateWitness(input);
            await circuit.checkConstraints(witness);
        });
    });

    describe("Nullifier and Timestamp Binding", function() {
        it("Should accept different nullifiers for same balance", async () => {
            const baseInput = {
                balance_1: "10000000",
                balance_2: "15000000",
                balance_3: "12000000",
                tier_lower_bound: TIERS[4].lower.toString(),
                tier_upper_bound: TIERS[4].upper.toString(),
                timestamp: "1708329600"
            };

            // First proof with nullifier 1
            const input1 = { ...baseInput, nullifier: "111111111" };
            const witness1 = await circuit.calculateWitness(input1);
            await circuit.checkConstraints(witness1);

            // Second proof with nullifier 2
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
                nullifier: "123456789"
            };

            // First proof at time 1
            const input1 = { ...baseInput, timestamp: "1708329600" };
            const witness1 = await circuit.calculateWitness(input1);
            await circuit.checkConstraints(witness1);

            // Second proof at time 2
            const input2 = { ...baseInput, timestamp: "1711008000" };
            const witness2 = await circuit.calculateWitness(input2);
            await circuit.checkConstraints(witness2);
        });
    });
});
