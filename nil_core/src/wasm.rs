use wasm_bindgen::prelude::*;
use crate::coding::expand_mdu;
use crate::kzg::KzgContext;

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