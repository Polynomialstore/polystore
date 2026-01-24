pub mod api;
pub mod bridge;
pub mod sidecar;

use api::{
    GatewayListFilesResponse, GatewayStatusResponse, GatewayTxResponse, GatewayUploadResponse,
    SignedIntentRequest,
};
use bridge::{BridgeManager, BridgeStartResponse};
use sidecar::{GatewayConfig, SidecarManager};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Clone)]
struct AppState {
    sidecar: Arc<SidecarManager>,
    bridge: Arc<BridgeManager>,
}

#[tauri::command]
async fn gateway_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: GatewayConfig,
) -> Result<sidecar::GatewayStartResponse, String> {
    let listen_addr = config
        .listen_addr
        .clone()
        .unwrap_or_else(|| "127.0.0.1:8080".to_string());
    let base_url = if listen_addr.starts_with("http://") || listen_addr.starts_with("https://") {
        listen_addr.clone()
    } else {
        format!("http://{listen_addr}")
    };

    if state.sidecar.base_url().is_err()
        && api::GatewayClient::new(base_url.clone())
            .status()
            .await
            .is_ok()
    {
        state.sidecar.set_base_url(base_url.clone())?;
        return Ok(sidecar::GatewayStartResponse { base_url, pid: 0 });
    }

    state.sidecar.start(app, config).await
}

#[tauri::command]
async fn gateway_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.sidecar.stop().await
}

#[tauri::command]
async fn gateway_status(state: State<'_, AppState>) -> Result<GatewayStatusResponse, String> {
    let base_url = match state.sidecar.base_url() {
        Ok(url) => url,
        Err(_) => {
            let default_url = "http://127.0.0.1:8080".to_string();
            state.sidecar.set_base_url(default_url.clone())?;
            default_url
        }
    };

    api::GatewayClient::new(base_url).status().await
}

#[tauri::command]
async fn gateway_attach(state: State<'_, AppState>, base_url: String) -> Result<(), String> {
    state.sidecar.set_base_url(base_url)
}

#[tauri::command]
async fn wallet_bridge_start(
    state: State<'_, AppState>,
    typed_data: serde_json::Value,
) -> Result<BridgeStartResponse, String> {
    state.bridge.start(typed_data).await
}

#[tauri::command]
async fn wallet_bridge_wait(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<String, String> {
    state.bridge.wait(request_id).await
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

#[tauri::command]
async fn deal_list_files(
    state: State<'_, AppState>,
    manifest_root: String,
    deal_id: u64,
    owner: String,
) -> Result<GatewayListFilesResponse, String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url)
        .list_files(manifest_root, deal_id, owner)
        .await
}

#[tauri::command]
async fn deal_fetch_file(
    state: State<'_, AppState>,
    manifest_root: String,
    deal_id: u64,
    owner: String,
    file_path: String,
    output_path: String,
) -> Result<(), String> {
    let base_url = state.sidecar.base_url()?;
    api::GatewayClient::new(base_url)
        .fetch_file(manifest_root, deal_id, owner, file_path, output_path)
        .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(SidecarManager::new());
    let bridge = Arc::new(BridgeManager::new());
    tauri::Builder::default()
        .manage(AppState { sidecar, bridge })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            gateway_start,
            gateway_stop,
            gateway_status,
            gateway_attach,
            wallet_bridge_start,
            wallet_bridge_wait,
            deal_upload_file,
            deal_create_evm,
            deal_update_content_evm,
            deal_list_files,
            deal_fetch_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
