package main

import (
	"fmt"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func replacePackedFATHeaderV3(wire []byte, header retrievalchallenge.FATV3Header) error {
	if len(wire) != types.MDU_SIZE {
		return fmt.Errorf("invalid MDU #0 size")
	}
	raw, err := header.Bytes()
	if err != nil {
		return err
	}
	start := 16 * types.BLOB_SIZE
	for i, value := range raw {
		scalar := i / 31
		wire[start+scalar*32] = 0
		wire[start+scalar*32+1+i%31] = value
	}
	return nil
}
