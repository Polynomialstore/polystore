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
    
    