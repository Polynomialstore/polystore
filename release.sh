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

# 2. Build nil_core (Rust)
echo ">>> Building nil_core..."
(
    cd nil_core
    cargo build --release
    # Copy static lib if needed, but Go build handles it via CGO flags usually
    # For release, we might want to package the dylib/staticlib?
    # For now, we assume the binaries are static enough.
)

# 3. Build nilchaind (Go)
echo ">>> Building nilchaind..."
(
    cd nilchain
    make proto-gen
    # Link against release lib
    export CGO_LDFLAGS="-L$(pwd)/../nil_core/target/release -lnil_core"
    go build -ldflags "-X main.Version=$VERSION" -o ../dist/bin/nilchaind ./cmd/nilchaind
)

# 4. Build nil_cli (Rust)
echo ">>> Building nil_cli..."
(
    cd nil_cli
    cargo build --release
    cp target/release/nil_cli ../dist/bin/
)

# 5. Build nil_s3 (Go)
echo ">>> Building nil_s3..."
(
    cd nil_s3
    go build -o ../dist/bin/nil_s3 .
)

# 6. Build Faucet
echo ">>> Building nil_faucet..."
(
    cd nil_faucet
    go build -o ../dist/bin/nil_faucet .
)

# 7. Package Configuration
echo ">>> Packaging Configs..."
mkdir -p dist/config
cp nilchain/trusted_setup.txt dist/config/
cp -r performance/ dist/performance/

# 8. Create Tarball
echo ">>> Creating Tarball..."
(
    cd dist
    tar -czvf nilstore-$VERSION-$(uname -s)-$(uname -m).tar.gz bin config performance
)

echo ">>> Release Ready: dist/nilstore-$VERSION-$(uname -s)-$(uname -m).tar.gz"
ls -lh dist/*.tar.gz
