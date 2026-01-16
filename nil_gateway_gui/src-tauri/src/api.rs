use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatusResponse {
    pub version: String,
    pub git_sha: String,
    pub build_time: String,
    pub mode: String,
    pub listening_addr: String,
    pub provider_base: Option<String>,
    pub p2p_addrs: Option<Vec<String>>,
    pub capabilities: HashMap<String, bool>,
    pub deps: HashMap<String, bool>,
    pub extra: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayUploadResponse {
    pub cid: String,
    pub manifest_root: String,
    pub size_bytes: u64,
    pub file_size_bytes: u64,
    pub allocated_length: u64,
    pub total_mdus: u64,
    pub witness_mdus: u64,
    pub filename: String,
    pub upload_id: String,
}

#[derive(Clone)]
pub struct GatewayClient {
    base_url: String,
    client: reqwest::Client,
}

impl GatewayClient {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url,
            client: reqwest::Client::new(),
        }
    }

    pub async fn status(&self) -> Result<GatewayStatusResponse, String> {
        let url = format!("{}/status", self.base_url.trim_end_matches('/'));
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|err| format!("status request failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("status failed: {}", resp.status()));
        }
        resp.json::<GatewayStatusResponse>()
            .await
            .map_err(|err| format!("invalid status payload: {err}"))
    }

    pub async fn upload_file(
        &self,
        deal_id: u64,
        owner: String,
        file_path: String,
        local_path: String,
    ) -> Result<GatewayUploadResponse, String> {
        let url = format!("{}/gateway/upload", self.base_url.trim_end_matches('/'));
        let data = tokio::fs::read(&local_path)
            .await
            .map_err(|err| format!("failed to read file: {err}"))?;
        let filename = Path::new(&local_path)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("upload.bin")
            .to_string();
        let part = multipart::Part::bytes(data)
            .file_name(filename)
            .mime_str("application/octet-stream")
            .map_err(|err| format!("invalid multipart: {err}"))?;
        let form = multipart::Form::new()
            .part("file", part)
            .text("owner", owner)
            .text("deal_id", deal_id.to_string())
            .text("file_path", file_path);

        let resp = self
            .client
            .post(url)
            .multipart(form)
            .send()
            .await
            .map_err(|err| format!("upload failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("upload failed: {}", resp.status()));
        }
        resp.json::<GatewayUploadResponse>()
            .await
            .map_err(|err| format!("invalid upload payload: {err}"))
    }
}
