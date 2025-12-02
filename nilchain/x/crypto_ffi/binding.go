package crypto_ffi

/*
#cgo LDFLAGS: -L${SRCDIR}/../../../nil_core/target/release -lnil_core -ldl -lpthread -lm
#include <stdlib.h>

int nil_init(const char* path);
int nil_verify_proof(const unsigned char* commitment, const unsigned char* z, const unsigned char* y, const unsigned char* proof);
*/
import "C"
import (
	"errors"
	"unsafe"
)

// Init loads the trusted setup from the given path.
func Init(path string) error {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	res := C.nil_init(cPath)
	if res == 0 {
		return nil
	}
	// nil_init returns -1, -2, -3 on error
	return errors.New("failed to initialize nil_core KZG (check path or file format)")
}

// VerifyProof verifies a KZG proof.
// Inputs must be correct lengths: commitment (48), z (32), y (32), proof (48).
func VerifyProof(commitment []byte, z []byte, y []byte, proof []byte) (bool, error) {
    if len(commitment) != 48 || len(z) != 32 || len(y) != 32 || len(proof) != 48 {
        return false, errors.New("invalid input lengths")
    }

    cComm := (*C.uchar)(unsafe.Pointer(&commitment[0]))
    cZ := (*C.uchar)(unsafe.Pointer(&z[0]))
    cY := (*C.uchar)(unsafe.Pointer(&y[0]))
    cProof := (*C.uchar)(unsafe.Pointer(&proof[0]))

    res := C.nil_verify_proof(cComm, cZ, cY, cProof)
    if res == 1 {
        return true, nil
    } else if res == 0 {
        return false, nil
    } else {
        return false, errors.New("nil_core verification error (context not initialized?)")
    }
}
