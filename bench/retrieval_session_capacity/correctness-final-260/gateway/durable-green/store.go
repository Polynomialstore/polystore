package main
import("encoding/json";"fmt";bolt "go.etcd.io/bbolt";"polystorechain/x/polystorechain/types")
func storeOnChainSessionProof(sessionID string, proof types.ChainedProof) error {
	if sessionDB == nil {
		return fmt.Errorf("session db not initialized")
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return err
	}
	return sessionDB.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("onchain_session_proofs bucket missing")
		}

		current := b.Get([]byte(normalized))
		var proofs []types.ChainedProof
		if current != nil {
			if err := decodeLegacySessionProofs(current, &proofs); err != nil {
				return err
			}
		}
		for _, previous := range proofs {
			if previous.MduIndex == proof.MduIndex && previous.BlobIndex == proof.BlobIndex {
				return nil
			}
		}
		if len(proofs) >= 64 {
			return fmt.Errorf("legacy proof count exceeds limit")
		}
		proofs = append(proofs, proof)

		bz, err := json.Marshal(proofs)
		if err != nil {
			return err
		}
		if len(bz) > maxRetrievalMetadataBytes {
			return fmt.Errorf("legacy proof record exceeds limit")
		}
		return b.Put([]byte(normalized), bz)
	})
}
func loadOnChainSessionProofs(sessionID string) ([]types.ChainedProof, error) {
	if sessionDB == nil {
		return nil, fmt.Errorf("session db not initialized")
	}
	normalized, _, err := parseSessionIDHex(sessionID)
	if err != nil {
		return nil, err
	}
	var proofs []types.ChainedProof
	err = sessionDB.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(onChainSessionProofsBucket)
		if b == nil {
			return fmt.Errorf("proof bucket missing")
		}
		v := b.Get([]byte(normalized))
		if v == nil {
			return nil
		}
		return decodeLegacySessionProofs(v, &proofs)
	})
	return proofs, err
}
