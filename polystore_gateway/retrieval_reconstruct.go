package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Missing deputy bytes are recovered under the original frozen authority. LCD
// assignments are location hints only: every accepted source blob must match
// the commitment list already authenticated against that generation's root.
// Keep exactly K source shards (one MDU), one candidate, and one target. Never
// publish repair artifacts or substitute a new session, root, geometry or payee.
func reconstructFrozenSessionSlot(ctx context.Context, dir string, f *frozenRetrievalSession, user *authenticatedUserMDU) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c := f.Context
	if c.Layout != retrievalchallenge.Stripe {
		return nil, fmt.Errorf("not a stripe session")
	}
	n := int(c.K + c.M)
	rows := uint64(64 / c.K)
	size := rows * types.BLOB_SIZE
	shards := make([][]byte, n)
	count := 0
	accept := func(slot int, data []byte) bool {
		if uint64(len(data)) != size {
			return false
		}
		for row := uint64(0); row < rows; row++ {
			if ctx.Err() != nil {
				return false
			}
			commitment, err := crypto_ffi.CommitReceivedBlob(data[row*types.BLOB_SIZE : (row+1)*types.BLOB_SIZE])
			leaf := uint64(slot)*rows + row
			if err != nil || leaf >= uint64(len(user.commitments)/48) || !bytes.Equal(commitment, user.commitments[leaf*48:(leaf+1)*48]) {
				return false
			}
		}
		return true
	}
	for slot := 0; slot < n && count < int(c.K); slot++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path := filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", c.StartMDU, slot))
		data, err := readExactArtifactRange(path, size, 0, size)
		if err == nil && accept(slot, data) {
			shards[slot] = data
			count++
		}
	}
	if count < int(c.K) {
		slots, err := resolveDealMode2Slots(ctx, c.DealID)
		if err != nil {
			return nil, err
		}
		// At most two location hints per legal slot, no recursive repair or retries.
		order := make([]int, 0, n)
		order = append(order, int(c.Slot))
		for slot := 0; slot < n; slot++ {
			if slot != int(c.Slot) {
				order = append(order, slot)
			}
		}
		for _, slot := range order {
			if count == int(c.K) {
				break
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if shards[slot] != nil || slot >= len(slots) {
				continue
			}
			for i, provider := range []string{slots[slot].Provider, slots[slot].PendingProvider} {
				if provider == "" || (i == 1 && provider == slots[slot].Provider) {
					continue
				}
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				base, err := resolveProviderHTTPBaseURL(ctx, provider)
				if err != nil {
					continue
				}
				data, err := fetchShardFromProvider(ctx, base, c.DealID, "0x"+hex.EncodeToString(c.Root[:]), c.StartMDU, uint64(slot), "0x"+hex.EncodeToString(c.ID[:]))
				if err != nil || !accept(slot, data) {
					continue
				}
				if slot == int(c.Slot) {
					return data, nil
				}
				shards[slot] = data
				count++
				break
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if count != int(c.K) {
		return nil, fmt.Errorf("not enough authenticated frozen-generation shards: have %d, need %d", count, c.K)
	}
	target, err := crypto_ffi.ReconstructSlotRs(shards, uint64(c.K), uint64(c.M), uint64(c.Slot))
	if err != nil {
		return nil, err
	}
	if !accept(int(c.Slot), target) {
		return nil, fmt.Errorf("reconstructed slot does not match frozen commitments")
	}
	return target, nil
}

func readFrozenSessionWindow(ctx context.Context, dir string, f *frozenRetrievalSession, user *authenticatedUserMDU) ([]byte, error) {
	c := f.Context
	rows := uint64(64 / c.K)
	offset := uint64(c.StartLeaf) % rows * types.BLOB_SIZE
	length := c.BlobCount * types.BLOB_SIZE
	path := filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", c.StartMDU))
	if c.Layout == retrievalchallenge.Stripe {
		path = filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", c.StartMDU, c.Slot))
	}
	window, err := readExactArtifactRange(path, rows*types.BLOB_SIZE, offset, length)
	if err == nil || c.Layout != retrievalchallenge.Stripe || !os.IsNotExist(err) {
		return window, err
	}
	target, err := reconstructFrozenSessionSlot(ctx, dir, f, user)
	if err != nil {
		return nil, err
	}
	return bytes.Clone(target[offset : offset+length]), nil
}
