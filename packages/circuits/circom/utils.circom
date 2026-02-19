pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/comparators.circom";

// Helper template: Compute MIN of 3 values
// Uses 2 pairwise comparisons to find the minimum
template Min3() {
    signal input in[3];
    signal output out;

    // Intermediate signals
    signal min_01;
    signal min_012;

    // Compare first two values
    component lt_01 = LessThan(64);  // Support up to 2^64 cents (~$184M)
    lt_01.in[0] <== in[0];
    lt_01.in[1] <== in[1];

    // min_01 = in[0] < in[1] ? in[0] : in[1]
    // If lt_01.out == 1, then in[0] - in[1] is negative, so we add back in[1]
    // If lt_01.out == 0, we get in[1]
    min_01 <== lt_01.out * (in[0] - in[1]) + in[1];

    // Compare min_01 with third value
    component lt_012 = LessThan(64);
    lt_012.in[0] <== min_01;
    lt_012.in[1] <== in[2];

    // out = min_01 < in[2] ? min_01 : in[2]
    out <== lt_012.out * (min_01 - in[2]) + in[2];
}
