pub mod api;
pub mod sidecar;

use api::{GatewayStatusResponse, GatewayTxResponse, GatewayUploadResponse, SignedIntentRequest};
use sidecar::{GatewayConfig, SidecarManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Clone)]
struct AppState {
    sidecar: Arc<SidecarManager>,
}

#[tauri::command]
async fn gateway_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: GatewayConfig,
) -> Result<sidecar::GatewayStartResponse, String> {
    state.sidecar.start(app, config).await
}

#[tauri::command]
async fn gateway_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.sidecar.stop().await
}

#[tauri::command]
async fn gateway_status(state: State<'_, AppState>) -> Result<GatewayStatusResponse, String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url).status().await
}

#[tauri::command]
async fn deal_upload_file(
    state: State<'_, AppState>,
    deal_id: u64,
    owner: String,
    file_path: String,
    local_path: String,
) -> Result<GatewayUploadResponse, String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url)
        .upload_file(deal_id, owner, file_path, local_path)
        .await
}

#[tauri::command]
async fn deal_create_evm(
    state: State<'_, AppState>,
    intent: serde_json::Value,
    signature: String,
) -> Result<GatewayTxResponse, String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url)
        .create_deal_from_evm(SignedIntentRequest {
            intent,
            evm_signature: signature,
        })
        .await
}

#[tauri::command]
async fn deal_update_content_evm(
    state: State<'_, AppState>,
    intent: serde_json::Value,
    signature: String,
) -> Result<GatewayTxResponse, String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url)
        .update_deal_content_from_evm(SignedIntentRequest {
            intent,
            evm_signature: signature,
        })
        .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(SidecarManager::new());
    tauri::Builder::default()
        .manage(AppState { sidecar })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            gateway_start,
            gateway_stop,
            gateway_status,
            deal_upload_file,
            deal_create_evm,
            deal_update_content_evm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
