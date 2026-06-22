package keeper_test

import "polystorechain/x/polystorechain/types"

const polyfsTestRawMduPayloadBytes = uint64((types.MDU_SIZE / 32) * 31)
const polyfsTestDefaultLeafCount = uint64(96)

func polyfsTestCeilDiv(n, d uint64) uint64 {
	if n == 0 {
		return 0
	}
	return 1 + (n-1)/d
}

func polyfsTestLayoutForSize(sizeBytes uint64) (totalMdus uint64, witnessMdus uint64) {
	userMdus := polyfsTestCeilDiv(sizeBytes, polyfsTestRawMduPayloadBytes)
	if userMdus == 0 {
		userMdus = 1
	}
	requiredWitnessBytes := userMdus * polyfsTestDefaultLeafCount * 48
	witnessMdus = polyfsTestCeilDiv(requiredWitnessBytes, uint64(types.MDU_SIZE))
	if witnessMdus == 0 {
		witnessMdus = 1
	}
	return 1 + witnessMdus + userMdus, witnessMdus
}

func polyfsTestCommittedSize(totalMdus uint64, witnessMdus uint64) uint64 {
	return (totalMdus - 1 - witnessMdus) * polyfsTestRawMduPayloadBytes
}
