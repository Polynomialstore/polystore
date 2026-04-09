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

type polyceEncoding uint8

const (
	polyceEncodingNone polyceEncoding = 0
	polyceEncodingZstd polyceEncoding = 1
)

var (
	errPolyceInvalidHeader = errors.New("invalid POLYCE header")
)

const (
	polyceMagic      = "POLC"
	polyceVersionV1  = uint8(1)
	polyceHeaderSize = 16 // 4+1+1+2+8
)

type polyceHeader struct {
	Encoding        polyceEncoding
	UncompressedLen uint64
}

func writePolyceV1Header(w io.Writer, enc polyceEncoding, uncompressedLen uint64) error {
	var hdr [polyceHeaderSize]byte
	copy(hdr[0:4], []byte(polyceMagic))
	hdr[4] = polyceVersionV1
	hdr[5] = byte(enc)
	// flags_u16 at [6:8] are reserved, must be 0
	binary.LittleEndian.PutUint64(hdr[8:16], uncompressedLen)
	_, err := w.Write(hdr[:])
	return err
}

// readPolyceV1Header reads a POLYCEv1 header. If the magic does not match, ok=false and err=nil.
func readPolyceV1Header(r io.Reader) (h polyceHeader, ok bool, err error) {
	var hdr [polyceHeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return polyceHeader{}, false, err
	}
	if string(hdr[0:4]) != polyceMagic {
		return polyceHeader{}, false, nil
	}
	if hdr[4] != polyceVersionV1 {
		return polyceHeader{}, true, errPolyceInvalidHeader
	}
	enc := polyceEncoding(hdr[5])
	if enc != polyceEncodingNone && enc != polyceEncodingZstd {
		return polyceHeader{}, true, errPolyceInvalidHeader
	}
	// flags must be 0 for v1
	if hdr[6] != 0 || hdr[7] != 0 {
		return polyceHeader{}, true, errPolyceInvalidHeader
	}
	uncompressedLen := binary.LittleEndian.Uint64(hdr[8:16])
	return polyceHeader{Encoding: enc, UncompressedLen: uncompressedLen}, true, nil
}

func detectPolyceHeaderFromFile(path string) (h polyceHeader, ok bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return polyceHeader{}, false, err
	}
	defer f.Close()

	buf := make([]byte, polyceHeaderSize)
	n, err := io.ReadFull(f, buf)
	if err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return polyceHeader{}, false, nil
		}
		return polyceHeader{}, false, err
	}
	if n < polyceHeaderSize {
		return polyceHeader{}, false, nil
	}
	return readPolyceV1Header(bytes.NewReader(buf))
}

type polyceWrapResult struct {
	Path            string
	Encoding        polyceEncoding
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

// maybeWrapPolyceZstd writes a POLYCEv1-wrapped file. If encoding is not worthwhile, it returns a result
// with Path == srcPath and Encoding == NONE (i.e. no wrapping is applied).
func maybeWrapPolyceZstd(ctx context.Context, srcPath string, minSavingsBps int, sampleBytes int) (polyceWrapResult, error) {
	fi, err := os.Stat(srcPath)
	if err != nil {
		return polyceWrapResult{}, err
	}
	if !fi.Mode().IsRegular() {
		return polyceWrapResult{}, fmt.Errorf("not a regular file")
	}
	if hdr, ok, err := detectPolyceHeaderFromFile(srcPath); err == nil && ok {
		encoding := hdr.Encoding
		uncompressedLen := hdr.UncompressedLen
		compressedLen := uint64(fi.Size())
		if compressedLen >= polyceHeaderSize {
			compressedLen -= polyceHeaderSize
		}
		return polyceWrapResult{
			Path:            srcPath,
			Encoding:        encoding,
			UncompressedLen: uncompressedLen,
			CompressedLen:   compressedLen,
		}, nil
	}
	uncompressedLen := uint64(fi.Size())
	if uncompressedLen == 0 {
		// Nothing to compress.
		return polyceWrapResult{Path: srcPath, Encoding: polyceEncodingNone, UncompressedLen: 0, CompressedLen: 0}, nil
	}

	if minSavingsBps < 0 {
		minSavingsBps = 0
	}
	if sampleBytes <= 0 {
		sampleBytes = 256 << 10
	}

	f, err := os.Open(srcPath)
	if err != nil {
		return polyceWrapResult{}, err
	}
	defer f.Close()

	sampleN := int64(sampleBytes)
	if int64(uncompressedLen) < sampleN {
		sampleN = int64(uncompressedLen)
	}
	sample, err := io.ReadAll(io.LimitReader(f, sampleN))
	if err != nil {
		return polyceWrapResult{}, err
	}
	if len(sample) == 0 {
		return polyceWrapResult{Path: srcPath, Encoding: polyceEncodingNone, UncompressedLen: uncompressedLen, CompressedLen: uncompressedLen}, nil
	}

	comp, err := compressSampleZstdLevel3(sample)
	if err != nil {
		return polyceWrapResult{}, err
	}

	savingsBps := 0
	if len(comp) < len(sample) {
		savingsBps = int((uint64(len(sample)-len(comp)) * 10_000) / uint64(len(sample)))
	}
	if savingsBps < minSavingsBps {
		// Keep raw bytes (no POLYCE header) to avoid overhead and preserve legacy behavior.
		return polyceWrapResult{Path: srcPath, Encoding: polyceEncodingNone, UncompressedLen: uncompressedLen, CompressedLen: uncompressedLen}, nil
	}

	// Re-open for a full streaming compression pass.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return polyceWrapResult{}, err
	}

	dstDir := filepath.Dir(srcPath)
	out, err := os.CreateTemp(dstDir, "polc-*-"+filepath.Base(srcPath))
	if err != nil {
		return polyceWrapResult{}, err
	}
	dstPath := out.Name()

	cleanup := func() {
		_ = out.Close()
		_ = os.Remove(dstPath)
	}

	if err := writePolyceV1Header(out, polyceEncodingZstd, uncompressedLen); err != nil {
		cleanup()
		return polyceWrapResult{}, err
	}

	zw, err := zstd.NewWriter(out, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(3)))
	if err != nil {
		cleanup()
		return polyceWrapResult{}, err
	}
	defer zw.Close()

	var reader io.Reader = f
	if ctx != nil {
		reader = &ctxReader{ctx: ctx, r: f}
	}

	if _, err := io.CopyBuffer(zw, reader, make([]byte, 256<<10)); err != nil {
		cleanup()
		return polyceWrapResult{}, err
	}
	if err := zw.Close(); err != nil {
		cleanup()
		return polyceWrapResult{}, err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dstPath)
		return polyceWrapResult{}, err
	}

	fi2, err := os.Stat(dstPath)
	if err != nil {
		_ = os.Remove(dstPath)
		return polyceWrapResult{}, err
	}

	return polyceWrapResult{
		Path:            dstPath,
		Encoding:        polyceEncodingZstd,
		UncompressedLen: uncompressedLen,
		CompressedLen:   uint64(fi2.Size()) - polyceHeaderSize,
	}, nil
}

func decodePolyceV1Bytes(b []byte) (payload []byte, h polyceHeader, ok bool, err error) {
	if len(b) < polyceHeaderSize {
		return b, polyceHeader{}, false, nil
	}
	hdr, ok, err := readPolyceV1Header(bytes.NewReader(b))
	if err != nil {
		return nil, polyceHeader{}, true, err
	}
	if !ok {
		return b, polyceHeader{}, false, nil
	}
	payload = b[polyceHeaderSize:]
	switch hdr.Encoding {
	case polyceEncodingNone:
		if uint64(len(payload)) != hdr.UncompressedLen {
			return nil, hdr, true, errPolyceInvalidHeader
		}
		return payload, hdr, true, nil
	case polyceEncodingZstd:
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
			return nil, hdr, true, errPolyceInvalidHeader
		}
		return out, hdr, true, nil
	default:
		return nil, hdr, true, errPolyceInvalidHeader
	}
}
