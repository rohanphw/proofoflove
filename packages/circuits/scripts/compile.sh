#!/bin/bash
set -e

# Change to the circuits directory (parent of scripts/)
cd "$(dirname "$0")/.."

echo "========================================"
echo "Compiling wealth_tier.circom"
echo "========================================"

# Check if circom is installed
if ! command -v circom &> /dev/null; then
    echo "ERROR: circom compiler not found!"
    echo ""
    echo "Please install circom first:"
    echo "  1. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "  2. Install circom: git clone https://github.com/iden3/circom.git"
    echo "     cd circom && cargo build --release && cargo install --path circom"
    echo ""
    echo "Or follow: https://docs.circom.io/getting-started/installation/"
    exit 1
fi

echo "Circom version: $(circom --version)"
echo ""

# Create build directory
mkdir -p build
mkdir -p build/keys

# Compile circuit to R1CS, WASM, and Witness Calculator
echo "Compiling circuit..."
circom circom/wealth_tier.circom \
    --r1cs \
    --wasm \
    --sym \
    --c \
    --output build/

echo ""
echo "✓ Circuit compiled successfully!"
echo ""

# Display circuit info
if command -v snarkjs &> /dev/null; then
    echo "Circuit information:"
    snarkjs r1cs info build/wealth_tier.r1cs
    echo ""
fi

echo "Build artifacts:"
echo "  - R1CS: build/wealth_tier.r1cs"
echo "  - WASM: build/wealth_tier_js/wealth_tier.wasm"
echo "  - Symbols: build/wealth_tier.sym"
echo ""
echo "Next step: Run ./scripts/setup.sh to generate proving/verification keys"
