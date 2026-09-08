package polystore

import (
	"encoding/binary"
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi"
	nilkeeper "polystorechain/x/polystorechain/keeper"
)

const maxABICallBytes = 256 * 1024
const maxABIValues = 8192

// validateABIAdmission is a shape/size guard, not a decoder. geth's Unpack still
// performs value decoding. Dynamic tails must be contiguous in declaration order:
// aliased/repeated tails would otherwise amplify one small calldata into many
// allocations. This is a consensus-affecting ABI canonicalization requirement.
func validateABIAdmission(args abi.Arguments, data []byte) error {
	if len(data) > maxABICallBytes {
		return fmt.Errorf("calldata exceeds %d bytes", maxABICallBytes)
	}
	remaining := maxABIValues
	end, err := walkABISequence(data, 0, len(args), func(i int) *abi.Type { return &args[i].Type }, &remaining)
	if err != nil {
		return err
	}
	if end != len(data) {
		return fmt.Errorf("unused ABI trailing bytes")
	}
	return nil
}

// ABI schema comes from the compiled contract, never from calldata.
func abiHeadSize(t *abi.Type) (size int, dynamic bool) {
	switch t.T {
	case abi.BytesTy, abi.StringTy, abi.SliceTy:
		return 32, true
	case abi.ArrayTy:
		size, dynamic = abiHeadSize(t.Elem)
		if dynamic {
			return 32, true
		}
		return t.Size * size, false
	case abi.TupleTy:
		for _, elem := range t.TupleElems {
			n, d := abiHeadSize(elem)
			if d {
				return 32, true
			}
			size += n
		}
		return size, false
	default:
		return 32, false
	}
}

func abiBoundedWord(data []byte, at int) (int, error) {
	if at < 0 || at > len(data)-32 {
		return 0, fmt.Errorf("truncated ABI word")
	}
	for _, b := range data[at : at+24] {
		if b != 0 {
			return 0, fmt.Errorf("ABI offset/count overflow")
		}
	}
	n := binary.BigEndian.Uint64(data[at+24 : at+32])
	if n > maxABICallBytes {
		return 0, fmt.Errorf("ABI offset/count exceeds envelope")
	}
	return int(n), nil
}

func walkABISequence(data []byte, base, count int, elem func(int) *abi.Type, remaining *int) (int, error) {
	if count < 0 || count > *remaining {
		return 0, fmt.Errorf("too many ABI values")
	}
	*remaining -= count
	head := 0
	for i := 0; i < count; i++ {
		n, _ := abiHeadSize(elem(i))
		head += n
	}
	if base < 0 || head > len(data)-base {
		return 0, fmt.Errorf("truncated ABI head")
	}
	tail := base + head
	cursor := base
	for i := 0; i < count; i++ {
		t := elem(i)
		n, dynamic := abiHeadSize(t)
		at := cursor
		if dynamic {
			offset, err := abiBoundedWord(data, cursor)
			if err != nil {
				return 0, err
			}
			if offset != tail-base {
				return 0, fmt.Errorf("ABI dynamic tails must be contiguous and unaliased")
			}
			at = tail
		}
		end, err := walkABIValue(data, at, t, remaining)
		if err != nil {
			return 0, err
		}
		if dynamic {
			tail = end
		} else if end != cursor+n {
			return 0, fmt.Errorf("invalid static ABI width")
		}
		cursor += n
	}
	return tail, nil
}

func walkABIValue(data []byte, at int, t *abi.Type, remaining *int) (int, error) {
	switch t.T {
	case abi.BytesTy, abi.StringTy:
		n, err := abiBoundedWord(data, at)
		if err != nil {
			return 0, err
		}
		if n > nilkeeper.MaxReceiptPathBytes {
			return 0, fmt.Errorf("ABI bytes/string exceeds %d bytes", nilkeeper.MaxReceiptPathBytes)
		}
		padded := (n + 31) / 32 * 32
		if at > len(data)-32-padded {
			return 0, fmt.Errorf("truncated ABI bytes")
		}
		return at + 32 + padded, nil
	case abi.SliceTy:
		count, err := abiBoundedWord(data, at)
		if err != nil {
			return 0, err
		}
		if count > nilkeeper.MaxProofsPerMessage {
			return 0, fmt.Errorf("ABI array exceeds %d elements", nilkeeper.MaxProofsPerMessage)
		}
		return walkABISequence(data, at+32, count, func(int) *abi.Type { return t.Elem }, remaining)
	case abi.ArrayTy:
		return walkABISequence(data, at, t.Size, func(int) *abi.Type { return t.Elem }, remaining)
	case abi.TupleTy:
		return walkABISequence(data, at, len(t.TupleElems), func(i int) *abi.Type { return t.TupleElems[i] }, remaining)
	default:
		if at < 0 || at > len(data)-32 {
			return 0, fmt.Errorf("truncated ABI value")
		}
		return at + 32, nil
	}
}
