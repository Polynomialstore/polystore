package types

import (
	"bytes"
	"encoding/hex"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"
	"polystorechain/pkg/retrievalchallenge"
)

func TestSessionCoverageDenominatorAndIndependentChallenges(t *testing.T) {
	// Session accounting measures encoded blob coverage, not unverified file bytes.
	// A 1 KiB encoded range needs one 128 KiB atom; 1 GiB needs all 8192 atoms.
	// The client must split at every MDU/slot boundary; no sampling discount applies.
	for _, size := range []uint64{1024, 1 << 30} {
		count := size / BlobSizeBytes
		if size%BlobSizeBytes != 0 {
			count++
		}
		setup, err := hex.DecodeString(RetrievalSetupDigest)
		require.NoError(t, err)
		payee := sdk.AccAddress(bytes.Repeat([]byte{1}, 20)).String()
		var proved uint64
		seen := make(map[[32]byte]bool)
		for start := uint64(0); start < count; {
			slot := uint32((start % 64) / 8)
			n := min(uint64(8), count-start)
			c := retrievalchallenge.Context{Version: 2, ChainID: "denominator-test", Kind: retrievalchallenge.Session,
				DealID: 1, Generation: 7, Layout: retrievalchallenge.Stripe, K: 8, M: 4, Slot: slot, MetadataMDUs: 2, UserMDUs: 128,
				StartMDU: 2 + start/64, StartLeaf: slot * 8, BlobCount: n, Window: retrievalchallenge.Window{Snapshot: 2, Anchor: 3, First: 4, Deadline: 20}, DealEnd: 100}
			copy(c.SetupDigest[:], setup)
			c.ID[0] = byte(start >> 8)
			c.ID[1] = byte(start)
			copy(c.Assigned[:], sdk.MustAccAddressFromBech32(payee))
			c.Payee = c.Assigned
			challenges, err := c.Challenges(bytes.Repeat([]byte{2}, 32))
			require.NoError(t, err)
			require.Len(t, challenges, int(n))
			for i, ch := range challenges {
				require.Equal(t, 2+start/64, ch.MDUIndex)
				require.Equal(t, slot*8+uint32(i), ch.LeafIndex)
				require.False(t, seen[ch.Z], "different session statements must not reuse a challenge point")
				seen[ch.Z] = true
				proved++
			}
			start += n
		}
		require.Equal(t, count, proved)
		if size == 1024 {
			require.Equal(t, uint64(1), proved)
		} else {
			require.Equal(t, uint64(8192), proved)
		}
	}
}

func TestVersionedSessionIDBindsChainAndPayee(t *testing.T) {
	legacy := bytes.Repeat([]byte{0x42}, 32)
	a, err := HashRetrievalSessionIDV2(legacy, "chain-a", bytes.Repeat([]byte{1}, 20))
	require.NoError(t, err)
	b, err := HashRetrievalSessionIDV2(legacy, "chain-b", bytes.Repeat([]byte{1}, 20))
	require.NoError(t, err)
	c, err := HashRetrievalSessionIDV2(legacy, "chain-a", bytes.Repeat([]byte{2}, 20))
	require.NoError(t, err)
	require.NotEqual(t, legacy, a)
	require.NotEqual(t, a, b)
	require.NotEqual(t, a, c)
}
