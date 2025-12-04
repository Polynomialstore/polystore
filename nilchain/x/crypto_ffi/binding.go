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
*/
import "C"
import (
	"errors"
	"fmt"
	"unsafe"

	"nilchain/x/nilchain/types" // Import types for MDU_SIZE
)

// Init loads the trusted setup from the given path.
func Init(path string) error {
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
