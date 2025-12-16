package crypto_ffi

/*
#cgo LDFLAGS: -L${SRCDIR}/../../../nil_core/target/release -lnil_core -ldl -lpthread -lm
#include <stdlib.h> // For C.free

// FFI declarations for Rust functions
int nil_init(const char* path);
int nil_compute_mdu_merkle_root(const unsigned char* mdu_bytes, size_t mdu_bytes_len, unsigned char* out_mdu_merkle_root);
int nil_verify_mdu_proof(
    const unsigned char* mdu_merkle_root,
    const unsigned char* challenged_kzg_commitment,
    const unsigned char* merkle_path_bytes,
    size_t merkle_path_len,
    unsigned int challenged_kzg_commitment_index,
    const unsigned char* z_value,
    const unsigned char* y_value,
    const unsigned char* kzg_opening_proof
);
int nil_compute_mdu_proof_test(
    const unsigned char* mdu_bytes,
    size_t mdu_bytes_len,
    unsigned int chunk_index,
    unsigned char* out_commitment,
    unsigned char* out_merkle_proof,
    size_t* out_merkle_proof_len,
    unsigned char* out_z,
    unsigned char* out_y,
    unsigned char* out_kzg_proof
);
int nil_compute_manifest_commitment(
    const unsigned char* hashes_ptr,
    size_t num_hashes,
    unsigned char* out_commitment,
    unsigned char* out_manifest_blob
);
int nil_compute_manifest_proof(
    const unsigned char* manifest_blob,
    unsigned long long mdu_index,
    unsigned char* out_proof,
    unsigned char* out_y
);
int nil_compute_blob_proof(
    const unsigned char* blob_bytes,
    size_t blob_bytes_len,
    const unsigned char* z_bytes,
    unsigned char* out_proof,
    unsigned char* out_y
);
int nil_verify_chained_proof(
    const unsigned char* manifest_commitment,
    unsigned long long mdu_index,
    const unsigned char* manifest_proof,
    const unsigned char* mdu_merkle_root,
    const unsigned char* blob_commitment,
    unsigned long long blob_index,
    const unsigned char* blob_merkle_proof,
    size_t blob_merkle_proof_len,
    const unsigned char* blob_z,
    const unsigned char* blob_y,
    const unsigned char* blob_proof
);

typedef void* Mdu0BuilderPtr;
Mdu0BuilderPtr nil_mdu0_builder_new(unsigned long long max_user_mdus);
void nil_mdu0_builder_free(Mdu0BuilderPtr ptr);
Mdu0BuilderPtr nil_mdu0_builder_load(const unsigned char* data_ptr, size_t len, unsigned long long max_user_mdus);
int nil_mdu0_builder_bytes(Mdu0BuilderPtr ptr, unsigned char* out_ptr, size_t out_len);
int nil_mdu0_append_file(Mdu0BuilderPtr ptr, const char* path_ptr, unsigned long long size, unsigned long long start_offset);
int nil_mdu0_set_root(Mdu0BuilderPtr ptr, unsigned long long index, const unsigned char* root_ptr);
int nil_mdu0_get_root(Mdu0BuilderPtr ptr, unsigned long long index, unsigned char* root_ptr);
unsigned long long nil_mdu0_get_witness_count(Mdu0BuilderPtr ptr);
unsigned int nil_mdu0_get_record_count(Mdu0BuilderPtr ptr);

typedef struct {
    unsigned long long start_offset;
    unsigned long long length_and_flags;
    unsigned long long timestamp;
    unsigned char path[40];
} FileRecordV1;

int nil_mdu0_get_record(Mdu0BuilderPtr ptr, unsigned int index, FileRecordV1* out_rec);
*/
import "C"
import (
	"errors"
	"fmt"
	"os"
	"unsafe"

	"nilchain/x/nilchain/types" // Import types for MDU_SIZE
)

// --- Layout FFI Wrappers ---

type FileRecordV1 struct {
	StartOffset    uint64
	LengthAndFlags uint64
	Timestamp      uint64
	Path           [40]byte
}

func PackLengthAndFlags(length uint64, flags uint8) uint64 {
	// Clear top 8 bits of length just in case
	cleanLength := length & 0x00FFFFFFFFFFFFFF
	// Shift flags to top
	packedFlags := uint64(flags) << 56
	return packedFlags | cleanLength
}

func UnpackLengthAndFlags(val uint64) (length uint64, flags uint8) {
	length = val & 0x00FFFFFFFFFFFFFF
	flags = uint8(val >> 56)
	return length, flags
}

type Mdu0Builder struct {
	ptr C.Mdu0BuilderPtr
}

func NewMdu0Builder(maxUserMdus uint64) *Mdu0Builder {
	ptr := C.nil_mdu0_builder_new(C.ulonglong(maxUserMdus))
	return &Mdu0Builder{ptr: ptr}
}

func LoadMdu0Builder(data []byte, maxUserMdus uint64) (*Mdu0Builder, error) {
	if len(data) != types.MDU_SIZE {
		return nil, errors.New("invalid size")
	}
	ptr := C.nil_mdu0_builder_load((*C.uchar)(unsafe.Pointer(&data[0])), C.size_t(len(data)), C.ulonglong(maxUserMdus))
	if ptr == nil {
		return nil, errors.New("failed to load builder")
	}
	return &Mdu0Builder{ptr: ptr}, nil
}

func (b *Mdu0Builder) Free() {
	if b.ptr != nil {
		C.nil_mdu0_builder_free(b.ptr)
		b.ptr = nil
	}
}

func (b *Mdu0Builder) Bytes() ([]byte, error) {
	out := make([]byte, types.MDU_SIZE)
	res := C.nil_mdu0_builder_bytes(b.ptr, (*C.uchar)(unsafe.Pointer(&out[0])), C.size_t(len(out)))
	if res != 0 {
		return nil, errors.New("failed to get bytes")
	}
	return out, nil
}

func (b *Mdu0Builder) AppendFile(path string, size uint64, startOffset uint64) error {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	res := C.nil_mdu0_append_file(b.ptr, cPath, C.ulonglong(size), C.ulonglong(startOffset))
	if res != 0 {
		return fmt.Errorf("append failed: %d", res)
	}
	return nil
}

func (b *Mdu0Builder) SetRoot(index uint64, root []byte) error {
	if len(root) != 32 {
		return errors.New("invalid root length")
    }
	res := C.nil_mdu0_set_root(b.ptr, C.ulonglong(index), (*C.uchar)(unsafe.Pointer(&root[0])))
	if res != 0 {
		return fmt.Errorf("set root failed: %d", res)
	}
	return nil
}

func (b *Mdu0Builder) GetRoot(index uint64) ([]byte, error) {
	out := make([]byte, 32)
	res := C.nil_mdu0_get_root(b.ptr, C.ulonglong(index), (*C.uchar)(unsafe.Pointer(&out[0])))
	if res != 0 {
		return nil, fmt.Errorf("get root failed: %d", res)
	}
	return out, nil
}

func (b *Mdu0Builder) GetWitnessCount() uint64 {
	return uint64(C.nil_mdu0_get_witness_count(b.ptr))
}

func (b *Mdu0Builder) GetRecordCount() uint32 {
	return uint32(C.nil_mdu0_get_record_count(b.ptr))
}

func (b *Mdu0Builder) GetRecord(index uint32) (FileRecordV1, error) {
	var rec FileRecordV1
	res := C.nil_mdu0_get_record(b.ptr, C.uint(index), (*C.FileRecordV1)(unsafe.Pointer(&rec)))
	if res != 0 {
		return FileRecordV1{}, fmt.Errorf("failed to get record: %d", res)
	}
	return rec, nil
}

// Init loads the trusted setup from the given path.
func Init(path string) error {
	fmt.Fprintf(os.Stderr, "Initializing KZG with path: %s\n", path)
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	res := C.nil_init(cPath)
	if res == 0 {
		return nil
	}
	return errors.New("failed to initialize nil_core KZG (check path or file format)")
}

// ComputeMduMerkleRoot computes the Merkle root of KZG commitments for an 8 MiB MDU.
// mdu_bytes must be exactly 8 MiB (types.MDU_SIZE).
func ComputeMduMerkleRoot(mdu_bytes []byte) ([]byte, error) {
	if len(mdu_bytes) != types.MDU_SIZE {
		return nil, fmt.Errorf("invalid mdu_bytes length: expected %d, got %d", types.MDU_SIZE, len(mdu_bytes))
	}

	outRoot := make([]byte, 32) // Merkle root is 32 bytes

	cMduBytes := (*C.uchar)(unsafe.Pointer(&mdu_bytes[0]))
	cOutRoot := (*C.uchar)(unsafe.Pointer(&outRoot[0]))

	res := C.nil_compute_mdu_merkle_root(cMduBytes, C.size_t(len(mdu_bytes)), cOutRoot)
	if res != 0 {
		return nil, fmt.Errorf("nil_compute_mdu_merkle_root failed with code: %d", res)
	}

	return outRoot, nil
}

// ComputeManifestProof computes a KZG proof for a specific MDU inclusion in the Manifest.
func ComputeManifestProof(manifest_blob []byte, mdu_index uint64) (proof []byte, y []byte, err error) {
	if len(manifest_blob) != types.BLOB_SIZE { // Assuming types.BLOB_SIZE is 128KB (131072)
		return nil, nil, fmt.Errorf("invalid manifest_blob length: expected %d, got %d", types.BLOB_SIZE, len(manifest_blob))
	}

	proof = make([]byte, 48)
	y = make([]byte, 32)

	cManifestBlob := (*C.uchar)(unsafe.Pointer(&manifest_blob[0]))
	cProof := (*C.uchar)(unsafe.Pointer(&proof[0]))
	cY := (*C.uchar)(unsafe.Pointer(&y[0]))

	res := C.nil_compute_manifest_proof(
		cManifestBlob,
		C.ulonglong(mdu_index),
		cProof,
		cY,
	)

	if res != 0 {
		return nil, nil, fmt.Errorf("nil_compute_manifest_proof failed with code: %d", res)
	}

	return proof, y, nil
}

// ComputeManifestCommitment computes the 48-byte ManifestRoot commitment (G1) and the corresponding
// 128 KiB Manifest blob from a list of MDU roots (32-byte each).
func ComputeManifestCommitment(mdu_roots [][]byte) (commitment []byte, manifest_blob []byte, err error) {
	if len(mdu_roots) == 0 {
		return nil, nil, errors.New("mdu_roots must be non-empty")
	}
	flat := make([]byte, 0, len(mdu_roots)*32)
	for i, r := range mdu_roots {
		if len(r) != 32 {
			return nil, nil, fmt.Errorf("invalid mdu_roots[%d] length: expected 32, got %d", i, len(r))
		}
		flat = append(flat, r...)
	}

	commitment = make([]byte, 48)
	manifest_blob = make([]byte, types.BLOB_SIZE)

	cRoots := (*C.uchar)(unsafe.Pointer(&flat[0]))
	cCommitment := (*C.uchar)(unsafe.Pointer(&commitment[0]))
	cManifestBlob := (*C.uchar)(unsafe.Pointer(&manifest_blob[0]))

	res := C.nil_compute_manifest_commitment(
		cRoots,
		C.size_t(len(mdu_roots)),
		cCommitment,
		cManifestBlob,
	)
	if res != 0 {
		return nil, nil, fmt.Errorf("nil_compute_manifest_commitment failed with code: %d", res)
	}
	return commitment, manifest_blob, nil
}

// ComputeBlobProof computes a KZG opening proof for a single encoded 128 KiB blob.
func ComputeBlobProof(blob_bytes []byte, z_bytes []byte) (proof []byte, y []byte, err error) {
	if len(blob_bytes) != types.BLOB_SIZE {
		return nil, nil, fmt.Errorf("invalid blob_bytes length: expected %d, got %d", types.BLOB_SIZE, len(blob_bytes))
	}
	if len(z_bytes) != 32 {
		return nil, nil, fmt.Errorf("invalid z_bytes length: expected 32, got %d", len(z_bytes))
	}

	proof = make([]byte, 48)
	y = make([]byte, 32)

	cBlob := (*C.uchar)(unsafe.Pointer(&blob_bytes[0]))
	cZ := (*C.uchar)(unsafe.Pointer(&z_bytes[0]))
	cProof := (*C.uchar)(unsafe.Pointer(&proof[0]))
	cY := (*C.uchar)(unsafe.Pointer(&y[0]))

	res := C.nil_compute_blob_proof(
		cBlob,
		C.size_t(len(blob_bytes)),
		cZ,
		cProof,
		cY,
	)
	if res != 0 {
		return nil, nil, fmt.Errorf("nil_compute_blob_proof failed with code: %d", res)
	}
	return proof, y, nil
}

// VerifyMduProof verifies a KZG proof for a single 128 KiB blob within an MDU,
// including Merkle proof verification.
func VerifyMduProof(
	mdu_merkle_root []byte,
	challenged_kzg_commitment []byte,
	merkle_path_bytes []byte,
	challenged_kzg_commitment_index uint32,
	z_value []byte,
	y_value []byte,
	kzg_opening_proof []byte,
) (bool, error) {
	// Input validation for lengths based on Rust FFI expectations
	if len(mdu_merkle_root) != 32 || len(challenged_kzg_commitment) != 48 ||
		len(z_value) != 32 || len(y_value) != 32 || len(kzg_opening_proof) != 48 {
		return false, errors.New("invalid input lengths for MDU proof components")
	}

	cMduMerkleRoot := (*C.uchar)(unsafe.Pointer(&mdu_merkle_root[0]))
	cChallengedKzgCommitment := (*C.uchar)(unsafe.Pointer(&challenged_kzg_commitment[0]))
	cMerklePathBytes := (*C.uchar)(unsafe.Pointer(&merkle_path_bytes[0]))
	cZValue := (*C.uchar)(unsafe.Pointer(&z_value[0]))
	cYValue := (*C.uchar)(unsafe.Pointer(&y_value[0]))
	cKzgOpeningProof := (*C.uchar)(unsafe.Pointer(&kzg_opening_proof[0]))

	res := C.nil_verify_mdu_proof(
		cMduMerkleRoot,
		cChallengedKzgCommitment,
		cMerklePathBytes,
		C.size_t(len(merkle_path_bytes)),
		C.uint(challenged_kzg_commitment_index),
		cZValue,
		cYValue,
		cKzgOpeningProof,
	)

	if res == 1 {
		return true, nil
	} else if res == 0 {
		return false, nil
	} else {
		return false, fmt.Errorf("nil_verify_mdu_proof failed with code: %d", res)
	}
}

// VerifyChainedProof verifies a "Triple Proof" (Chained Verification).
//
// Hop 1: Verify MDU Root is in Manifest (KZG).
// Hop 2: Verify Blob Commitment is in MDU (Merkle).
// Hop 3: Verify Data is in Blob (KZG).
func VerifyChainedProof(
	manifest_commitment []byte,
	mdu_index uint64,
	manifest_proof []byte,
	mdu_merkle_root []byte,
	blob_commitment []byte,
	blob_index uint64,
	blob_merkle_proof []byte,
	blob_z []byte,
	blob_y []byte,
	blob_proof []byte,
) (bool, error) {
	if len(manifest_commitment) != 48 || len(manifest_proof) != 48 || len(mdu_merkle_root) != 32 ||
		len(blob_commitment) != 48 || len(blob_z) != 32 || len(blob_y) != 32 || len(blob_proof) != 48 {
		return false, errors.New("invalid input lengths for Chained Proof components")
	}

	cManifestCommitment := (*C.uchar)(unsafe.Pointer(&manifest_commitment[0]))
	cManifestProof := (*C.uchar)(unsafe.Pointer(&manifest_proof[0]))
	cMduMerkleRoot := (*C.uchar)(unsafe.Pointer(&mdu_merkle_root[0]))
	cBlobCommitment := (*C.uchar)(unsafe.Pointer(&blob_commitment[0]))
	cBlobMerkleProof := (*C.uchar)(unsafe.Pointer(&blob_merkle_proof[0]))
	cBlobZ := (*C.uchar)(unsafe.Pointer(&blob_z[0]))
	cBlobY := (*C.uchar)(unsafe.Pointer(&blob_y[0]))
	cBlobProof := (*C.uchar)(unsafe.Pointer(&blob_proof[0]))

	res := C.nil_verify_chained_proof(
		cManifestCommitment,
		C.ulonglong(mdu_index),
		cManifestProof,
		cMduMerkleRoot,
		cBlobCommitment,
		C.ulonglong(blob_index),
		cBlobMerkleProof,
		C.size_t(len(blob_merkle_proof)),
		cBlobZ,
		cBlobY,
		cBlobProof,
	)

	if res == 1 {
		return true, nil
	} else if res == 0 {
		return false, nil
	} else {
		return false, fmt.Errorf("nil_verify_chained_proof failed with code: %d", res)
	}
}

// ComputeMduProofTest is a helper for integration testing.
// It computes all components required for a valid MsgProveLiveness proof.
func ComputeMduProofTest(mdu_bytes []byte, chunk_index uint32) (
	commitment []byte,
	merkle_proof []byte,
	z []byte,
	y []byte,
	kzg_proof []byte,
	err error,
) {
	if len(mdu_bytes) != types.MDU_SIZE {
		return nil, nil, nil, nil, nil, fmt.Errorf("invalid mdu_bytes length: expected %d, got %d", types.MDU_SIZE, len(mdu_bytes))
	}

	// Allocate output buffers
	commitment = make([]byte, 48)
	merkle_proof_buf := make([]byte, 32*10) // Sufficient for depth 6 tree (64 leaves)
	var merkle_proof_len C.size_t = C.size_t(len(merkle_proof_buf))
	z = make([]byte, 32)
	y = make([]byte, 32)
	kzg_proof = make([]byte, 48)

	cMduBytes := (*C.uchar)(unsafe.Pointer(&mdu_bytes[0]))
	cCommitment := (*C.uchar)(unsafe.Pointer(&commitment[0]))
	cMerkleProof := (*C.uchar)(unsafe.Pointer(&merkle_proof_buf[0]))
	cZ := (*C.uchar)(unsafe.Pointer(&z[0]))
	cY := (*C.uchar)(unsafe.Pointer(&y[0]))
	cKzgProof := (*C.uchar)(unsafe.Pointer(&kzg_proof[0]))

	res := C.nil_compute_mdu_proof_test(
		cMduBytes,
		C.size_t(len(mdu_bytes)),
		C.uint(chunk_index),
		cCommitment,
		cMerkleProof,
		&merkle_proof_len,
		cZ,
		cY,
		cKzgProof,
	)

	if res != 0 {
		return nil, nil, nil, nil, nil, fmt.Errorf("nil_compute_mdu_proof_test failed with code: %d", res)
	}

	merkle_proof = merkle_proof_buf[:merkle_proof_len]
	return commitment, merkle_proof, z, y, kzg_proof, nil
}
