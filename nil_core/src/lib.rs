#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;
pub mod kzg;
pub mod utils;
#[cfg(target_arch = "wasm32")]
pub mod wasm;