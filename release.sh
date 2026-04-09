#!/bin/bash
set -e

# Release Builder
# Usage: ./release.sh [version]

VERSION=$1
if [ -z "$VERSION" ]; then
    VERSION="v0.1.0-testnet"
fi

echo ">>> Building Release: $VERSION"

# 1. Clean
echo ">>> Cleaning..."
rm -rf dist
mkdir -p dist/bin

# 2. Build polystore_core (Rust)
echo ">>> Building polystore_core..."
(
    cd polystore_core
    cargo build --release
    # Copy static lib if needed, but Go build handles it via CGO flags usually
    # For release, we might want to package the dylib/staticlib?
    # For now, we assume the binaries are static enough.
)

# 3. Build polystorechaind (Go)
echo ">>> Building polystorechaind..."
(
    cd polystorechain
    make proto-gen
    # Link against release lib
    export CGO_LDFLAGS="-L$(pwd)/../polystore_core/target/release -lpolystore_core"
    go build -ldflags "-X main.Version=$VERSION" -o ../dist/bin/polystorechaind ./cmd/polystorechaind
)

# 4. Build polystore_cli (Rust)
echo ">>> Building polystore_cli..."
(
    cd polystore_cli
    cargo build --release
    cp target/release/polystore_cli ../dist/bin/
)

# 5. Build polystore_gateway (Go)
echo ">>> Building polystore_gateway..."
(
    cd polystore_gateway
    go build -o ../dist/bin/polystore_gateway .
)

# 6. Build Faucet
echo ">>> Building polystore_faucet..."
(
    cd polystore_faucet
    go build -o ../dist/bin/polystore_faucet .
)

# 7. Package Configuration
echo ">>> Packaging Configs..."
mkdir -p dist/config
cp polystorechain/trusted_setup.txt dist/config/
cp -r performance/ dist/performance/

# 8. Create Tarball
echo ">>> Creating Tarball..."
(
    cd dist
    tar -czvf polystore-$VERSION-$(uname -s)-$(uname -m).tar.gz bin config performance
)

echo ">>> Release Ready: dist/polystore-$VERSION-$(uname -s)-$(uname -m).tar.gz"
ls -lh dist/*.tar.gz
