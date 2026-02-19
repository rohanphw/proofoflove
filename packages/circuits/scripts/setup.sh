#!/bin/bash
set -e

# Change to the circuits directory (parent of scripts/)
cd "$(dirname "$0")/.."

echo "========================================"
echo "Running Trusted Setup"
echo "========================================"
echo ""
echo "WARNING: This is a DEVELOPMENT setup."
echo "For production, run a multi-party computation ceremony."
echo ""

# Check if circuit is compiled
if [ ! -f "build/wealth_tier.r1cs" ]; then
    echo "ERROR: Circuit not compiled. Run ./scripts/compile.sh first."
    exit 1
fi

# Check if snarkjs is available
if ! command -v snarkjs &> /dev/null; then
    echo "ERROR: snarkjs not found. Installing..."
    npm install -g snarkjs
fi

cd build/keys/

PTAU_FILE="powersOfTau28_hez_final_12.ptau"
CIRCUIT_NAME="wealth_tier"

# Phase 1: Download Powers of Tau ceremony file (universal setup)
if [ ! -f "$PTAU_FILE" ]; then
    echo "Downloading Powers of Tau ceremony file..."
    echo "This is a one-time download (~50MB)"

    # Use curl on macOS, wget on Linux
    PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau"
    if command -v curl &> /dev/null; then
        curl -L --progress-bar $PTAU_URL -o $PTAU_FILE
    elif command -v wget &> /dev/null; then
        wget -q --show-progress $PTAU_URL
    else
        echo "ERROR: Neither curl nor wget found. Please install one of them."
        exit 1
    fi

    echo "✓ Downloaded $PTAU_FILE"
    echo ""
else
    echo "✓ Powers of Tau file already exists"
    echo ""
fi

# Phase 2: Circuit-specific setup
echo "Starting Phase 2 trusted setup..."
echo ""

# Generate initial zkey (circuit-specific proving key)
echo "1/5: Generating initial zkey..."
snarkjs groth16 setup ../${CIRCUIT_NAME}.r1cs $PTAU_FILE ${CIRCUIT_NAME}_0000.zkey > /dev/null 2>&1

# Contribute randomness (development setup - single contribution)
echo "2/5: Contributing randomness..."
ENTROPY=$(head -c 32 /dev/urandom | shasum -a 256 | cut -d' ' -f1)
snarkjs zkey contribute ${CIRCUIT_NAME}_0000.zkey ${CIRCUIT_NAME}_0001.zkey \
    --name="Dev Contribution" \
    --entropy="$ENTROPY" \
    -v > /dev/null 2>&1

# Apply beacon (adds public randomness for additional security)
echo "3/5: Applying beacon randomness..."
snarkjs zkey beacon ${CIRCUIT_NAME}_0001.zkey ${CIRCUIT_NAME}_final.zkey \
    0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f 10 \
    --name="Final Beacon" \
    -v > /dev/null 2>&1

# Export verification key
echo "4/5: Exporting verification key..."
snarkjs zkey export verificationkey ${CIRCUIT_NAME}_final.zkey verification_key.json

# Cleanup intermediate keys
echo "5/5: Cleaning up..."
rm -f ${CIRCUIT_NAME}_0000.zkey ${CIRCUIT_NAME}_0001.zkey

echo ""
echo "✓ Trusted setup complete!"
echo ""
echo "Generated files:"
echo "  - Proving key: ${CIRCUIT_NAME}_final.zkey ($(du -h ${CIRCUIT_NAME}_final.zkey | cut -f1))"
echo "  - Verification key: verification_key.json"
echo ""

# Verify the keys
echo "Verifying setup..."
snarkjs zkey verify ../${CIRCUIT_NAME}.r1cs $PTAU_FILE ${CIRCUIT_NAME}_final.zkey

echo ""
echo "========================================"
echo "Setup successful! Ready to generate proofs."
echo "========================================"
