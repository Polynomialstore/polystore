#!/bin/bash
set -e

echo "🚀 Starting NilStore Network Installation..."

# 1. Check Dependencies
echo "🔍 Checking dependencies..."
if ! command -v go &> /dev/null; then
    echo "❌ Go is not installed."
    exit 1
fi
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust/Cargo is not installed."
    exit 1
fi

# Create bin directory
mkdir -p bin
BIN_DIR="$(pwd)/bin"
echo "📂 Binaries will be placed in $BIN_DIR"

# 2. Build nil_core (FFI Lib)
echo "🛠️  Building nil_core (Crypto FFI)..."
cd nil_core
cargo build --release
cd ..

# 3. Build nilchaind (L1)
echo "🛠️  Building nilchaind (L1 Node)..."
# We need to ensure CGO can find the rust library
export CGO_LDFLAGS="-L$(pwd)/nil_core/target/release -lnil_core -ldl -lpthread -lm"
# Use ignite if available, else standard go build
if command -v ignite &> /dev/null; then
    # ignite chain build might be tricky with custom CGO flags if not configured in config.yml
    # So we fall back to go build for reliability in this script
    cd nilchain
    go build -o ../bin/nilchaind ./cmd/nilchaind
    cd ..
else
    cd nilchain
    go build -o ../bin/nilchaind ./cmd/nilchaind
    cd ..
fi

# 4. Build nil_p2p (Storage Sidecar)
echo "🛠️  Building nil_p2p (Storage Sidecar)..."
cd nil_p2p
cargo build --release
cp target/release/nil_p2p ../bin/
cd ..

# 5. Build nil_faucet
echo "🛠️  Building nil_faucet..."
cd nil_faucet
go build -o ../bin/nil_faucet main.go
cd ..

# 6. Build nil-cli
echo "🛠️  Building nil-cli..."
cd nil_cli
cargo build --release
cp target/release/nil-cli ../bin/
cd ..

echo "-------------------------------------------"
echo "✅ Installation Complete!"
echo "-------------------------------------------"
echo "Binaries are located in 'bin/':"
ls -1 bin/
echo ""
echo "To start the L1 chain:"
echo "  ./bin/nilchaind start"
echo ""
echo "To start a P2P storage node:"
echo "  ./bin/nil_p2p --port 9000"
echo ""
echo "To verify installation:"
echo "  ./bin/nil-cli --help"
