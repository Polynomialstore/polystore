use crate::coding::expand_mdu;
use crate::kzg::KzgContext;
use crate::builder::Mdu0Builder;
use crate::layout::{FileRecordV1, pack_length_and_flags};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct NilWasm {
    kzg_ctx: KzgContext,
}

#[wasm_bindgen]
impl NilWasm {
    #[wasm_bindgen(constructor)]
    pub fn new(trusted_setup_bytes: &[u8]) -> Result<NilWasm, JsValue> {
        console_error_panic_hook::set_once();
        // Use std::io::Cursor to adapt bytes to Read trait
        let cursor = std::io::Cursor::new(trusted_setup_bytes);
        let ctx = KzgContext::load_from_reader(cursor)
            .map_err(|e| JsValue::from_str(&format!("Failed to load setup: {:?}", e)))?;
        Ok(NilWasm { kzg_ctx: ctx })
    }

    pub fn expand_file(&self, data: &[u8]) -> Result<JsValue, JsValue> {
        let res = expand_mdu(&self.kzg_ctx, data)
            .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn commit_mdu(&self, mdu_bytes: &[u8]) -> Result<JsValue, JsValue> {
        if mdu_bytes.len() != crate::kzg::MDU_SIZE {
            return Err(JsValue::from_str("MDU bytes must be exactly 8 MiB"));
        }

        let commitments = self
            .kzg_ctx
            .mdu_to_kzg_commitments(mdu_bytes)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;

        let root = self
            .kzg_ctx
            .create_mdu_merkle_root(&commitments)
            .map_err(|e| JsValue::from_str(&format!("Merkle root failed: {:?}", e)))?;

        let mut witness_flat = Vec::with_capacity(commitments.len() * 48);
        for c in commitments {
            witness_flat.extend_from_slice(&c);
        }

        #[derive(serde::Serialize)]
        struct CommitResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
        }

        let res = CommitResult {
            witness_flat,
            mdu_root: root.to_vec(),
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn commit_blobs(&self, blobs_flat: &[u8]) -> Result<JsValue, JsValue> {
        if blobs_flat.len() % crate::kzg::BLOB_SIZE != 0 {
            return Err(JsValue::from_str("Blobs length must be a multiple of 128 KiB"));
        }

        let count = blobs_flat.len() / crate::kzg::BLOB_SIZE;
        let mut commitments = Vec::with_capacity(count * 48);

        for i in 0..count {
            let start = i * crate::kzg::BLOB_SIZE;
            let end = start + crate::kzg::BLOB_SIZE;
            let c = self
                .kzg_ctx
                .blob_to_commitment(&blobs_flat[start..end])
                .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
            commitments.extend_from_slice(&c);
        }

        serde_wasm_bindgen::to_value(&commitments)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn compute_manifest(&self, roots_flat: &[u8]) -> Result<JsValue, JsValue> {
        if roots_flat.len() % 32 != 0 {
            return Err(JsValue::from_str("Roots length must be multiple of 32"));
        }
        let count = roots_flat.len() / 32;
        let mut roots = Vec::with_capacity(count);
        for chunk in roots_flat.chunks_exact(32) {
            let mut r = [0u8; 32];
            r.copy_from_slice(chunk);
            roots.push(r);
        }

        let (commitment, blob) = self.kzg_ctx.compute_manifest_commitment(&roots)
            .map_err(|e| JsValue::from_str(&format!("Compute manifest failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct ManifestResult {
            root: Vec<u8>,
            blob: Vec<u8>,
        }
        let res = ManifestResult { root: commitment.to_vec(), blob };
        serde_wasm_bindgen::to_value(&res).map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn compute_mdu_root(&self, witness_flat: &[u8]) -> Result<JsValue, JsValue> {
        if witness_flat.len() % 48 != 0 {
             return Err(JsValue::from_str("Witness length must be multiple of 48"));
        }
        let count = witness_flat.len() / 48;
        let mut commitments = Vec::with_capacity(count);
        for chunk in witness_flat.chunks_exact(48) {
            let mut c = [0u8; 48];
            c.copy_from_slice(chunk);
            commitments.push(c);
        }
        
        let root = self.kzg_ctx.create_mdu_merkle_root(&commitments)
            .map_err(|e| JsValue::from_str(&format!("Merkle root failed: {:?}", e)))?;
            
        serde_wasm_bindgen::to_value(&root.to_vec())
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }
}

#[wasm_bindgen]
pub struct WasmMdu0Builder {
    inner: Mdu0Builder,
}

#[wasm_bindgen]
impl WasmMdu0Builder {
    #[wasm_bindgen(constructor)]
    pub fn new(max_user_mdus: u64) -> WasmMdu0Builder {
        WasmMdu0Builder { inner: Mdu0Builder::new(max_user_mdus) }
    }

    pub fn append_file(&mut self, path: &str, size: u64, start_offset: u64) -> Result<(), JsValue> {
        let mut path_bytes = [0u8; 40];
        let bytes = path.as_bytes();
        if bytes.len() > 40 {
             return Err(JsValue::from_str("path too long"));
        }
        path_bytes[..bytes.len()].copy_from_slice(bytes);

        let rec = FileRecordV1 {
            start_offset,
            length_and_flags: pack_length_and_flags(size, 0), // Default flags 0 for now
            timestamp: 0,
            path: path_bytes,
        };
        self.inner.append_file_record(rec).map_err(|e| JsValue::from_str(&e))
    }

    pub fn bytes(&mut self) -> Vec<u8> {
        self.inner.bytes().to_vec()
    }
    
        pub fn set_root(&mut self, index: u64, root: &[u8]) -> Result<(), JsValue> {
    
            if root.len() != 32 {
    
                return Err(JsValue::from_str("root must be 32 bytes"));
    
            }
    
            let mut r = [0u8; 32];
    
            r.copy_from_slice(root);
    
            self.inner.set_root(index, r).map_err(|e| JsValue::from_str(&e))
    
        }
    
    
    
        pub fn get_witness_count(&self) -> u64 {
    
            self.inner.witness_mdu_count
    
        }
    
    }
    
    
