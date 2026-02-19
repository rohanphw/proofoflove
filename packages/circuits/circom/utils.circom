pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/comparators.circom";

// Helper template: Compute AVERAGE of 3 values (integer division, floor)
//
// Integer division isn't a native operation in ZK circuits, so we prove it
// via the relationship:  sum = avg * 3 + remainder,  where 0 <= remainder < 3
//
// The prover supplies `avg` and `remainder` as private witnesses, and the
// circuit constrains them to be consistent with the inputs.
template Avg3() {
    signal input in[3];
    signal output out;

    // Sum the three inputs
    signal sum;
    sum <== in[0] + in[1] + in[2];

    // Witness: the integer quotient (average) and remainder
    // These are computed by the prover and verified by the constraints below
    signal avg;
    signal remainder;

    // Compute witnesses (hint to the prover — not a constraint)
    avg <-- sum \ 3;
    remainder <-- sum % 3;

    // Constraint 1: sum == avg * 3 + remainder
    // This ensures avg and remainder are consistent with the actual sum
    signal avg_times_3;
    avg_times_3 <== avg * 3;
    sum === avg_times_3 + remainder;

    // Constraint 2: remainder < 3
    // We need to prove 0 <= remainder < 3
    // Since signals in Circom are field elements, we check remainder ∈ {0, 1, 2}
    // by proving (remainder)(remainder - 1)(remainder - 2) == 0
    signal r_minus_1;
    r_minus_1 <== remainder - 1;
    signal r_minus_2;
    r_minus_2 <== remainder - 2;

    signal prod_01;
    prod_01 <== remainder * r_minus_1;
    prod_01 * r_minus_2 === 0;

    // Constraint 3: avg >= 0 (non-negative)
    // Use LessThan to ensure avg fits in 64 bits (implicitly non-negative)
    component avg_range = LessThan(64);
    avg_range.in[0] <== avg;
    avg_range.in[1] <== 6148914691236517206; // ~2^62, well above any realistic balance
    avg_range.out === 1;

    out <== avg;
}