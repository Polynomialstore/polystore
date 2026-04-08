package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

type nilceEncoding uint8

const (
	nilceEncodingNone nilceEncoding = 0
	nilceEncodingZstd nilceEncoding = 1
)

var (
	errNilceInvalidHeader = errors.New("invalid NILCE header")
)

const (
	nilceMagic      = "NILC"
	nilceVersionV1  = uint8(1)
	nilceHeaderSize = 16 // 4+1+1+2+8
)

type nilceHeader struct {
	Encoding        nilceEncoding
	UncompressedLen uint64
}

func writeNilceV1Header(w io.Writer, enc nilceEncoding, uncompressedLen uint64) error {
	var hdr [nilceHeaderSize]byte
	copy(hdr[0:4], []byte(nilceMagic))
	hdr[4] = nilceVersionV1
	hdr[5] = byte(enc)
	// flags_u16 at [6:8] are reserved, must be 0
	binary.LittleEndian.PutUint64(hdr[8:16], uncompressedLen)
	_, err := w.Write(hdr[:])
	return err
}

// readNilceV1Header reads a NILCEv1 header. If the magic does not match, ok=false and err=nil.
func readNilceV1Header(r io.Reader) (h nilceHeader, ok bool, err error) {
	var hdr [nilceHeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nilceHeader{}, false, err
	}
	if string(hdr[0:4]) != nilceMagic {
		return nilceHeader{}, false, nil
	}
	if hdr[4] != nilceVersionV1 {
		return nilceHeader{}, true, errNilceInvalidHeader
	}
	enc := nilceEncoding(hdr[5])
	if enc != nilceEncodingNone && enc != nilceEncodingZstd {
		return nilceHeader{}, true, errNilceInvalidHeader
	}
	// flags must be 0 for v1
	if hdr[6] != 0 || hdr[7] != 0 {
		return nilceHeader{}, true, errNilceInvalidHeader
	}
	uncompressedLen := binary.LittleEndian.Uint64(hdr[8:16])
	return nilceHeader{Encoding: enc, UncompressedLen: uncompressedLen}, true, nil
}

func detectNilceHeaderFromFile(path string) (h nilceHeader, ok bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nilceHeader{}, false, err
	}
	defer f.Close()

	buf := make([]byte, nilceHeaderSize)
	n, err := io.ReadFull(f, buf)
	if err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return nilceHeader{}, false, nil
		}
		return nilceHeader{}, false, err
	}
	if n < nilceHeaderSize {
		return nilceHeader{}, false, nil
	}
	return readNilceV1Header(bytes.NewReader(buf))
}

type nilceWrapResult struct {
	Path            string
	Encoding        nilceEncoding
	UncompressedLen uint64
	CompressedLen   uint64
}

func compressSampleZstdLevel3(sample []byte) ([]byte, error) {
	enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(3)))
	if err != nil {
		return nil, err
	}
	defer enc.Close()
	return enc.EncodeAll(sample, make([]byte, 0, len(sample))), nil
}

// maybeWrapNilceZstd writes a NILCEv1-wrapped file. If encoding is not worthwhile, it returns a result
// with Path == srcPath and Encoding == NONE (i.e. no wrapping is applied).
func maybeWrapNilceZstd(ctx context.Context, srcPath string, minSavingsBps int, sampleBytes int) (nilceWrapResult, error) {
	fi, err := os.Stat(srcPath)
	if err != nil {
		return nilceWrapResult{}, err
	}
	if !fi.Mode().IsRegular() {
		return nilceWrapResult{}, fmt.Errorf("not a regular file")
	}
	if hdr, ok, err := detectNilceHeaderFromFile(srcPath); err == nil && ok {
		encoding := hdr.Encoding
		uncompressedLen := hdr.UncompressedLen
		compressedLen := uint64(fi.Size())
		if compressedLen >= nilceHeaderSize {
			compressedLen -= nilceHeaderSize
		}
		return nilceWrapResult{
			Path:            srcPath,
			Encoding:        encoding,
			UncompressedLen: uncompressedLen,
			CompressedLen:   compressedLen,
		}, nil
	}
	uncompressedLen := uint64(fi.Size())
	if uncompressedLen == 0 {
		// Nothing to compress.
		return nilceWrapResult{Path: srcPath, Encoding: nilceEncodingNone, UncompressedLen: 0, CompressedLen: 0}, nil
	}

	if minSavingsBps < 0 {
		minSavingsBps = 0
	}
	if sampleBytes <= 0 {
		sampleBytes = 256 << 10
	}

	f, err := os.Open(srcPath)
	if err != nil {
		return nilceWrapResult{}, err
	}
	defer f.Close()

	sampleN := int64(sampleBytes)
	if int64(uncompressedLen) < sampleN {
		sampleN = int64(uncompressedLen)
	}
	sample, err := io.ReadAll(io.LimitReader(f, sampleN))
	if err != nil {
		return nilceWrapResult{}, err
	}
	if len(sample) == 0 {
		return nilceWrapResult{Path: srcPath, Encoding: nilceEncodingNone, UncompressedLen: uncompressedLen, CompressedLen: uncompressedLen}, nil
	}

	comp, err := compressSampleZstdLevel3(sample)
	if err != nil {
		return nilceWrapResult{}, err
	}

	savingsBps := 0
	if len(comp) < len(sample) {
		savingsBps = int((uint64(len(sample)-len(comp)) * 10_000) / uint64(len(sample)))
	}
	if savingsBps < minSavingsBps {
		// Keep raw bytes (no NILCE header) to avoid overhead and preserve legacy behavior.
		return nilceWrapResult{Path: srcPath, Encoding: nilceEncodingNone, UncompressedLen: uncompressedLen, CompressedLen: uncompressedLen}, nil
	}

	// Re-open for a full streaming compression pass.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nilceWrapResult{}, err
	}

	dstDir := filepath.Dir(srcPath)
	out, err := os.CreateTemp(dstDir, "nilc-*-"+filepath.Base(srcPath))
	if err != nil {
		return nilceWrapResult{}, err
	}
	dstPath := out.Name()

	cleanup := func() {
		_ = out.Close()
		_ = os.Remove(dstPath)
	}

	if err := writeNilceV1Header(out, nilceEncodingZstd, uncompressedLen); err != nil {
		cleanup()
		return nilceWrapResult{}, err
	}

	zw, err := zstd.NewWriter(out, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(3)))
	if err != nil {
		cleanup()
		return nilceWrapResult{}, err
	}
	defer zw.Close()

	var reader io.Reader = f
	if ctx != nil {
		reader = &ctxReader{ctx: ctx, r: f}
	}

	if _, err := io.CopyBuffer(zw, reader, make([]byte, 256<<10)); err != nil {
		cleanup()
		return nilceWrapResult{}, err
	}
	if err := zw.Close(); err != nil {
		cleanup()
		return nilceWrapResult{}, err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dstPath)
		return nilceWrapResult{}, err
	}

	fi2, err := os.Stat(dstPath)
	if err != nil {
		_ = os.Remove(dstPath)
		return nilceWrapResult{}, err
	}

	return nilceWrapResult{
		Path:            dstPath,
		Encoding:        nilceEncodingZstd,
		UncompressedLen: uncompressedLen,
		CompressedLen:   uint64(fi2.Size()) - nilceHeaderSize,
	}, nil
}

func decodeNilceV1Bytes(b []byte) (payload []byte, h nilceHeader, ok bool, err error) {
	if len(b) < nilceHeaderSize {
		return b, nilceHeader{}, false, nil
	}
	hdr, ok, err := readNilceV1Header(bytes.NewReader(b))
	if err != nil {
		return nil, nilceHeader{}, true, err
	}
	if !ok {
		return b, nilceHeader{}, false, nil
	}
	payload = b[nilceHeaderSize:]
	switch hdr.Encoding {
	case nilceEncodingNone:
		if uint64(len(payload)) != hdr.UncompressedLen {
			return nil, hdr, true, errNilceInvalidHeader
		}
		return payload, hdr, true, nil
	case nilceEncodingZstd:
		dec, err := zstd.NewReader(nil)
		if err != nil {
			return nil, hdr, true, err
		}
		defer dec.Close()
		out, err := dec.DecodeAll(payload, make([]byte, 0, hdr.UncompressedLen))
		if err != nil {
			return nil, hdr, true, err
		}
		if uint64(len(out)) != hdr.UncompressedLen {
			return nil, hdr, true, errNilceInvalidHeader
		}
		return out, hdr, true, nil
	default:
		return nil, hdr, true, errNilceInvalidHeader
	}
}
