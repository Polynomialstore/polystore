package types

const (
	MDU_SIZE            = 8 * 1024 * 1024 // 8 MiB Mega-Data Unit
	SHARD_SIZE          = 1 * 1024 * 1024 // 1 MiB Shard
	BLOB_SIZE           = 128 * 1024      // 128 KiB KZG Blob (EIP-4844)
	BLOBS_PER_MDU       = MDU_SIZE / BLOB_SIZE // 64 Blobs per MDU
	DealBaseReplication = 12                // Base replication factor (n in RS(n,k))
	ProofWindow         = 10                // Blocks allowed between proofs before slashing
)