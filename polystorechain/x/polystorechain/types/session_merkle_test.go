package types_test

import (
	"encoding/hex"
	"testing"

	gethCommon "github.com/ethereum/go-ethereum/common"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"polystorechain/x/polystorechain/types"
)

func addrBytes(n byte) []byte {
	b := make([]byte, 20)
	b[19] = n
	return b
}

func TestVerifyKeccakMerklePath_Vector4Leaves(t *testing.T) {
	// Leaves are keccak(address_bytes). Internal hashing is keccak(left||right).
	// Tree is built pairwise, duplicating the last node on odd levels.
	l0 := gethCrypto.Keccak256Hash(addrBytes(1))
	l1 := gethCrypto.Keccak256Hash(addrBytes(2))
	l2 := gethCrypto.Keccak256Hash(addrBytes(3))
	l3 := gethCrypto.Keccak256Hash(addrBytes(4))

	// root = keccak(keccak(l0||l1) || keccak(l2||l3))
	p0 := gethCrypto.Keccak256Hash(l0.Bytes(), l1.Bytes())
	p1 := gethCrypto.Keccak256Hash(l2.Bytes(), l3.Bytes())
	root := gethCrypto.Keccak256Hash(p0.Bytes(), p1.Bytes())

	const expectedRootHex = "49690e544e5fcea5037854c7c7998244479aed8abc047c6640dcce15a2386356"
	require.Equal(t, expectedRootHex, hex.EncodeToString(root.Bytes()))

	// Proof for leaf index 2: [sibling=l3, sibling=p0]
	path := [][]byte{
		l3.Bytes(),
		p0.Bytes(),
	}
	require.Equal(t, "a876da518a393dbd067dc72abfa08d475ed6447fca96d92ec3f9e7eba503ca61", hex.EncodeToString(path[0]))
	require.Equal(t, "f95c14e6953c95195639e8266ab1a6850864d59a829da9f9b13602ee522f672b", hex.EncodeToString(path[1]))

	require.True(t, types.VerifyKeccakMerklePath(root, l2, 2, path))
	require.False(t, types.VerifyKeccakMerklePath(root, l2, 1, path))
}

func TestVerifyKeccakMerklePath_Vector3Leaves_DuplicateLast(t *testing.T) {
	// Three leaves: last leaf is duplicated at the first level.
	l0 := gethCrypto.Keccak256Hash(addrBytes(1))
	l1 := gethCrypto.Keccak256Hash(addrBytes(2))
	l2 := gethCrypto.Keccak256Hash(addrBytes(3))

	// root = keccak(keccak(l0||l1) || keccak(l2||l2))
	p0 := gethCrypto.Keccak256Hash(l0.Bytes(), l1.Bytes())
	p1 := gethCrypto.Keccak256Hash(l2.Bytes(), l2.Bytes())
	root := gethCrypto.Keccak256Hash(p0.Bytes(), p1.Bytes())

	const expectedRootHex = "9b2beaffc72968fd3a694096468c78d0b800d436964d4cf55f8f708803cbb683"
	require.Equal(t, expectedRootHex, hex.EncodeToString(root.Bytes()))

	// Proof for leaf index 2: [sibling=l2 (duplicate), sibling=p0]
	path := [][]byte{
		l2.Bytes(),
		p0.Bytes(),
	}
	require.Equal(t, "5b70e80538acdabd6137353b0f9d8d149f4dba91e8be2e7946e409bfdbe685b9", hex.EncodeToString(path[0]))
	require.Equal(t, "f95c14e6953c95195639e8266ab1a6850864d59a829da9f9b13602ee522f672b", hex.EncodeToString(path[1]))

	require.True(t, types.VerifyKeccakMerklePath(root, l2, 2, path))
}

func TestVerifyKeccakMerklePath_RejectsNon32ByteSibling(t *testing.T) {
	root := gethCommon.HexToHash("0x" + hex.EncodeToString(make([]byte, 32)))
	leaf := gethCrypto.Keccak256Hash([]byte("leaf"))
	require.False(t, types.VerifyKeccakMerklePath(root, leaf, 0, [][]byte{{1, 2, 3}}))
}
