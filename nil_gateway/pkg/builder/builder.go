package builder

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"nil_gateway/pkg/layout"
)

const (
	MduSize             = 8 * 1024 * 1024 // 8 MiB
	BlobSize            = 128 * 1024      // 128 KiB
	RootTableStart      = 0
	RootTableEnd        = 16 * BlobSize
	FileTableStart      = 16 * BlobSize
	FileTableEnd        = 64 * BlobSize
	FileTableHeaderSize = 128
	FileRecordSize      = 64
	RootSize            = 32
)

type Mdu0Builder struct {
	buffer          []byte
	Header          layout.FileTableHeader
	WitnessMduCount uint64
	MaxUserMdus     uint64
}

// NewMdu0Builder initializes a clean 8MB MDU #0.
func NewMdu0Builder(maxUserMdus uint64) (*Mdu0Builder, error) {
	buf := make([]byte, MduSize)
	
	// Calculate W
	// Total Commitments = maxUserMdus * 64
	// Total Bytes = Total Commitments * 48
	totalCommitmentBytes := float64(maxUserMdus * 64 * 48)
	w := uint64(math.Ceil(totalCommitmentBytes / float64(MduSize)))

	header := layout.FileTableHeader{
		Version:     1,
		RecordSize:  uint16(FileRecordSize),
		RecordCount: 0,
	}
	copy(header.Magic[:], layout.MagicNILF)

	b := &Mdu0Builder{
		buffer:          buf,
		Header:          header,
		WitnessMduCount: w,
		MaxUserMdus:     maxUserMdus,
	}
	
	// Flush header to buffer
	if err := b.flushHeader(); err != nil {
		return nil, err
	}

	return b, nil
}

// LoadMdu0Builder parses an existing 8MB buffer.
func LoadMdu0Builder(data []byte, maxUserMdus uint64) (*Mdu0Builder, error) {
	if len(data) != MduSize {
		return nil, errors.New("invalid MDU size")
	}

	b := &Mdu0Builder{
		buffer:      make([]byte, MduSize),
		MaxUserMdus: maxUserMdus,
	}
	copy(b.buffer, data)

	// Recalculate W (it's derived from maxUserMdus, not stored in MDU #0)
	totalCommitmentBytes := float64(maxUserMdus * 64 * 48)
	b.WitnessMduCount = uint64(math.Ceil(totalCommitmentBytes / float64(MduSize)))

	// Parse Header
	r := bytes.NewReader(b.buffer[FileTableStart : FileTableStart+FileTableHeaderSize])
	if err := binary.Read(r, binary.LittleEndian, &b.Header); err != nil {
		return nil, fmt.Errorf("failed to read header: %w", err)
	}

	if !bytes.Equal(b.Header.Magic[:], layout.MagicNILF) {
		return nil, errors.New("invalid magic")
	}

	return b, nil
}

func (b *Mdu0Builder) flushHeader() error {
	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.LittleEndian, &b.Header); err != nil {
		return err
	}
	copy(b.buffer[FileTableStart:], buf.Bytes())
	return nil
}

func (b *Mdu0Builder) Bytes() []byte {
	// Ensure header is sync'd
	b.flushHeader()
	return b.buffer
}

func (b *Mdu0Builder) GetRoot(index uint64) [32]byte {
	offset := RootTableStart + (index * RootSize)
	var root [32]byte
	copy(root[:], b.buffer[offset:offset+RootSize])
	return root
}

func (b *Mdu0Builder) SetRoot(index uint64, root [32]byte) error {
	offset := RootTableStart + (index * RootSize)
	if offset+RootSize > RootTableEnd {
		return errors.New("root index out of bounds")
	}
	copy(b.buffer[offset:], root[:])
	return nil
}

func (b *Mdu0Builder) GetFileRecord(index uint32) layout.FileRecordV1 {
	offset := FileTableStart + FileTableHeaderSize + (uint64(index) * FileRecordSize)
	var rec layout.FileRecordV1
	r := bytes.NewReader(b.buffer[offset : offset+FileRecordSize])
	binary.Read(r, binary.LittleEndian, &rec)
	return rec
}

func (b *Mdu0Builder) AppendFileRecord(rec layout.FileRecordV1) error {
	index := b.Header.RecordCount
	offset := FileTableStart + FileTableHeaderSize + (uint64(index) * FileRecordSize)
	
	if offset+FileRecordSize > FileTableEnd {
		return errors.New("file table full")
	}

	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.LittleEndian, &rec); err != nil {
		return err
	}
	copy(b.buffer[offset:], buf.Bytes())

	b.Header.RecordCount++
	return b.flushHeader()
}

func (b *Mdu0Builder) UpdateFileRecord(index uint32, rec layout.FileRecordV1) error {
	if index >= b.Header.RecordCount {
		return errors.New("index out of bounds")
	}
	offset := FileTableStart + FileTableHeaderSize + (uint64(index) * FileRecordSize)
	
	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.LittleEndian, &rec); err != nil {
		return err
	}
	copy(b.buffer[offset:], buf.Bytes())
	return nil
}

// FindFreeSlotAndInsert looks for a tombstone that fits. 
// If found, it splits the tombstone.
// If not found, it appends to the end.
func (b *Mdu0Builder) FindFreeSlotAndInsert(rec layout.FileRecordV1) (uint32, error) {
	requiredLen, _ := layout.UnpackLengthAndFlags(rec.LengthAndFlags)

	for i := uint32(0); i < b.Header.RecordCount; i++ {
		existing := b.GetFileRecord(i)
		// Check if Tombstone
		if existing.Path[0] == 0 {
			tombLen, _ := layout.UnpackLengthAndFlags(existing.LengthAndFlags)
			if tombLen >= requiredLen {
				// FOUND MATCH.
				
				// 1. Overwrite this slot with new record
				// Preserve the original StartOffset of the slot!
				rec.StartOffset = existing.StartOffset
				if err := b.UpdateFileRecord(i, rec); err != nil {
					return 0, err
				}

				// 2. Handle Split (if leftover space > 0)
				leftover := tombLen - requiredLen
				if leftover > 0 {
					// Append a new tombstone at the end
					newTomb := layout.FileRecordV1{
						StartOffset: existing.StartOffset + requiredLen,
						LengthAndFlags: layout.PackLengthAndFlags(leftover, 0),
					}
					// Path is already all zeros
					if err := b.AppendFileRecord(newTomb); err != nil {
						return 0, err
					}
				}
				return i, nil
			}
		}
	}

	// No suitable tombstone found. Append.
	// We need to determine StartOffset.
	// Naive approach: Just use allocated_length logic from caller?
	// Or track "NextOffset"?
	// For "Filesystem on Slab", append is linear.
	// But wait, if we append to FileTable, we need to know where the file data goes in the Slab.
	// The `StartOffset` in `rec` passed to this function must ALREADY be set by the caller if it's a new append.
	
	// Assumption: Caller sets StartOffset for Append.
	// Assumption: Caller handles logic for Reuse StartOffset? 
	// Ah, in Reuse case, we OVERWROTE rec.StartOffset with existing.StartOffset.
	// In Append case, we trust rec.StartOffset.
	
	err := b.AppendFileRecord(rec)
	return b.Header.RecordCount - 1, err
}
