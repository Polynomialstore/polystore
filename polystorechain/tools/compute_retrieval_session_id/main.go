package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"

	cosmosbech32 "github.com/cosmos/cosmos-sdk/types/bech32"

	polystoretypes "polystorechain/x/polystorechain/types"
)

func main() {
	var (
		owner          = flag.String("owner", "", "bech32 owner address")
		dealID         = flag.Uint64("deal-id", 0, "deal id")
		provider       = flag.String("provider", "", "bech32 provider address")
		manifestRoot   = flag.String("manifest-root", "", "48-byte manifest root as hex, with or without 0x")
		startMduIndex  = flag.Uint64("start-mdu-index", 0, "start mdu index")
		startBlobIndex = flag.Uint("start-blob-index", 0, "start blob index")
		blobCount      = flag.Uint64("blob-count", 0, "blob count")
		nonce          = flag.Uint64("nonce", 0, "nonce")
		expiresAt      = flag.Uint64("expires-at", 0, "expiry height")
	)
	flag.Parse()

	_, ownerAddr, err := cosmosbech32.DecodeAndConvert(strings.TrimSpace(*owner))
	must(err)
	_, providerAddr, err := cosmosbech32.DecodeAndConvert(strings.TrimSpace(*provider))
	must(err)

	rootHex := strings.TrimSpace(*manifestRoot)
	rootHex = strings.TrimPrefix(rootHex, "0x")
	rootHex = strings.TrimPrefix(rootHex, "0X")
	manifestRootBytes, err := hex.DecodeString(rootHex)
	must(err)

	sessionID, err := polystoretypes.HashRetrievalSessionID(
		ownerAddr,
		*dealID,
		providerAddr,
		manifestRootBytes,
		*startMduIndex,
		uint32(*startBlobIndex),
		*blobCount,
		*nonce,
		*expiresAt,
	)
	must(err)

	fmt.Printf("0x%s\n", strings.ToUpper(hex.EncodeToString(sessionID)))
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
