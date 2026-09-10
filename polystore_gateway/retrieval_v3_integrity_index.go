package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"

	"golang.org/x/sync/singleflight"
	"golang.org/x/sys/unix"
	"polystorechain/pkg/retrievalchallenge"
)

const (
	integrityIndexV3File        = "integrity_index_v3.bin"
	integrityIndexV3HeaderBytes = uint64(16)
	integrityIndexDiskReserveV3 = uint64(64 << 20)
)

var integrityIndexV3Magic = [8]byte{'N', 'I', 'L', 'I', 'V', '3', 'I', '1'}
var integrityIndexV3Builds singleflight.Group

func integrityIndexV3NodeCount(leaves uint64) (uint64, error) {
	if leaves == 0 || leaves > retrievalchallenge.MaxIntegrityLeaves {
		return 0, fmt.Errorf("invalid v3 integrity leaf count")
	}
	var nodes uint64
	for width := leaves; width > 1; {
		width = (width + 1) / 2
		nodes += width
	}
	return nodes, nil
}

func integrityIndexV3Size(leaves uint64) (uint64, error) {
	nodes, err := integrityIndexV3NodeCount(leaves)
	if err != nil || nodes > (math.MaxUint64-integrityIndexV3HeaderBytes)/32 {
		return 0, fmt.Errorf("invalid v3 integrity index size")
	}
	return integrityIndexV3HeaderBytes + nodes*32, nil
}

func validateIntegrityIndexV3(path string, leaves uint64) error {
	want, err := integrityIndexV3Size(leaves)
	if err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || uint64(info.Size()) != want {
		return fmt.Errorf("v3 integrity index has invalid type or size")
	}
	var header [integrityIndexV3HeaderBytes]byte
	if _, err := io.ReadFull(f, header[:]); err != nil || string(header[:8]) != string(integrityIndexV3Magic[:]) || binary.BigEndian.Uint64(header[8:]) != leaves {
		return fmt.Errorf("v3 integrity index has invalid header")
	}
	return nil
}

func requireIntegrityIndexDiskV3(dir string, bytes uint64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(dir, &stat); err != nil {
		return fmt.Errorf("cannot inspect v3 integrity index capacity: %w", err)
	}
	if stat.Bsize <= 0 || stat.Bavail < 0 {
		return fmt.Errorf("invalid v3 integrity index filesystem capacity")
	}
	blockSize, availableBlocks := uint64(stat.Bsize), uint64(stat.Bavail)
	if blockSize == 0 || availableBlocks > math.MaxUint64/blockSize {
		return fmt.Errorf("invalid v3 integrity index filesystem capacity")
	}
	available := blockSize * availableBlocks
	if bytes > math.MaxUint64-integrityIndexDiskReserveV3 || available < bytes+integrityIndexDiskReserveV3 {
		return fmt.Errorf("insufficient disk capacity for v3 integrity index")
	}
	return nil
}

func integrityLeafCountV3(users uint64) (uint64, error) {
	if users == 0 || users > retrievalchallenge.MaxIntegrityLeaves/retrievalchallenge.IntegrityLeavesPerUserMDU {
		return 0, fmt.Errorf("invalid v3 user MDU count")
	}
	return users * retrievalchallenge.IntegrityLeavesPerUserMDU, nil
}

// buildIntegrityIndexV3 writes every internal level in order. The existing raw
// leaf vector is level zero; later levels are read back from the same temporary
// file, keeping memory independent of the generation size.
func buildIntegrityIndexV3(ctx context.Context, dir string, key retrievalGenerationKey) (string, error) {
	leaves, err := integrityLeafCountV3(key.Users)
	if err != nil {
		return "", err
	}
	wantSize, err := integrityIndexV3Size(leaves)
	if err != nil {
		return "", err
	}
	if err := requireIntegrityIndexDiskV3(dir, wantSize); err != nil {
		return "", err
	}
	leafPath := filepath.Join(dir, integrityLeavesV3File)
	leafFile, err := os.Open(leafPath)
	if err != nil {
		return "", err
	}
	defer leafFile.Close()
	info, err := leafFile.Stat()
	if err != nil || !info.Mode().IsRegular() || uint64(info.Size()) != leaves*32 {
		return "", fmt.Errorf("integrity leaf vector has invalid type or size")
	}

	tmp, err := os.CreateTemp(dir, ".integrity-index-v3-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmpPath)
		}
	}()
	var header [integrityIndexV3HeaderBytes]byte
	copy(header[:8], integrityIndexV3Magic[:])
	binary.BigEndian.PutUint64(header[8:], leaves)
	if _, err := tmp.Write(header[:]); err != nil {
		return "", err
	}

	source, sourceOffset, width := io.ReaderAt(leafFile), int64(0), leaves
	var root [32]byte
	for width > 1 {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		nextWidth := (width + 1) / 2
		levelOffset, err := tmp.Seek(0, io.SeekCurrent)
		if err != nil {
			return "", err
		}
		reader := bufio.NewReaderSize(io.NewSectionReader(source, sourceOffset, int64(width*32)), 1<<20)
		writer := bufio.NewWriterSize(tmp, 1<<20)
		for i := uint64(0); i < nextWidth; i++ {
			if i&0x3fff == 0 {
				if err := ctx.Err(); err != nil {
					return "", err
				}
			}
			var left, right [32]byte
			if _, err := io.ReadFull(reader, left[:]); err != nil {
				return "", fmt.Errorf("read v3 integrity level: %w", err)
			}
			right = left
			if 2*i+1 < width {
				if _, err := io.ReadFull(reader, right[:]); err != nil {
					return "", fmt.Errorf("read v3 integrity level: %w", err)
				}
			}
			root = retrievalchallenge.IntegrityParentV3(left, right)
			if _, err := writer.Write(root[:]); err != nil {
				return "", err
			}
		}
		if err := writer.Flush(); err != nil {
			return "", err
		}
		source, sourceOffset, width = tmp, levelOffset, nextWidth
	}
	if root != key.Integrity {
		return "", fmt.Errorf("integrity leaf vector does not match authenticated header")
	}
	if err := tmp.Sync(); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	info, err = os.Stat(tmpPath)
	if err != nil || uint64(info.Size()) != wantSize {
		return "", fmt.Errorf("v3 integrity index build has invalid size")
	}
	keep = true
	return tmpPath, nil
}

func ensureIntegrityIndexV3(ctx context.Context, dir string, key retrievalGenerationKey) (string, error) {
	path := filepath.Join(dir, integrityIndexV3File)
	leaves, err := integrityLeafCountV3(key.Users)
	if err != nil {
		return "", err
	}
	if err := validateIntegrityIndexV3(path, leaves); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	value, err, _ := integrityIndexV3Builds.Do(fmt.Sprintf("%s:%#v", abs, key), func() (interface{}, error) {
		if err := validateIntegrityIndexV3(path, leaves); err == nil {
			return path, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		tmp, err := buildIntegrityIndexV3(ctx, dir, key)
		if err != nil {
			return nil, err
		}
		defer os.Remove(tmp)
		if err := publishImmutableArtifact(tmp, path); err != nil {
			return nil, err
		}
		return path, validateIntegrityIndexV3(path, leaves)
	})
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return value.(string), nil
}

func readIntegrityPathV3(indexPath, leavesPath string, position, leafCount uint64) ([][32]byte, error) {
	if position >= leafCount {
		return nil, fmt.Errorf("invalid v3 integrity position")
	}
	if err := validateIntegrityIndexV3(indexPath, leafCount); err != nil {
		return nil, err
	}
	leaves, err := os.Open(leavesPath)
	if err != nil {
		return nil, err
	}
	defer leaves.Close()
	index, err := os.Open(indexPath)
	if err != nil {
		return nil, err
	}
	defer index.Close()
	leafInfo, err := leaves.Stat()
	if err != nil || !leafInfo.Mode().IsRegular() || uint64(leafInfo.Size()) != leafCount*32 {
		return nil, fmt.Errorf("integrity leaf vector has invalid type or size")
	}

	path := make([][32]byte, 0, 23)
	width, pos, levelOffset := leafCount, position, int64(integrityIndexV3HeaderBytes)
	for level := 0; width > 1; level++ {
		sibling := pos ^ 1
		if sibling >= width {
			sibling = pos
		}
		var node [32]byte
		var reader io.ReaderAt = leaves
		offset := int64(sibling * 32)
		if level > 0 {
			reader = index
			offset = levelOffset + int64(sibling*32)
		}
		if _, err := reader.ReadAt(node[:], offset); err != nil {
			return nil, fmt.Errorf("read v3 integrity path: %w", err)
		}
		path = append(path, node)
		pos /= 2
		if level > 0 {
			levelOffset += int64(width * 32)
		}
		width = (width + 1) / 2
	}
	return path, nil
}
