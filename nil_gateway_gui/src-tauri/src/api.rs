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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayFileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub start_offset: u64,
    pub flags: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayListFilesResponse {
    pub manifest_root: String,
    pub total_size_bytes: u64,
    pub files: Vec<GatewayFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayTxResponse {
    pub status: Option<String>,
    pub tx_hash: String,
    pub deal_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedIntentRequest {
    pub intent: serde_json::Value,
    pub evm_signature: String,
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

    pub async fn list_files(
        &self,
        manifest_root: String,
        deal_id: u64,
        owner: String,
    ) -> Result<GatewayListFilesResponse, String> {
        let url = format!(
            "{}/gateway/list-files/{}",
            self.base_url.trim_end_matches('/'),
            manifest_root
        );
        let resp = self
            .client
            .get(url)
            .query(&[("deal_id", deal_id.to_string()), ("owner", owner)])
            .send()
            .await
            .map_err(|err| format!("list files failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("list files failed: {}", resp.status()));
        }
        resp.json::<GatewayListFilesResponse>()
            .await
            .map_err(|err| format!("invalid list files payload: {err}"))
    }

    pub async fn fetch_file(
        &self,
        manifest_root: String,
        deal_id: u64,
        owner: String,
        file_path: String,
        output_path: String,
    ) -> Result<(), String> {
        let url = format!(
            "{}/gateway/fetch/{}",
            self.base_url.trim_end_matches('/'),
            manifest_root
        );
        let resp = self
            .client
            .get(url)
            .query(&[
                ("deal_id", deal_id.to_string()),
                ("owner", owner),
                ("file_path", file_path),
            ])
            .send()
            .await
            .map_err(|err| format!("fetch failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("fetch failed: {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("fetch bytes failed: {err}"))?;
        tokio::fs::write(output_path, bytes)
            .await
            .map_err(|err| format!("write file failed: {err}"))?;
        Ok(())
    }

    pub async fn create_deal_from_evm(
        &self,
        req: SignedIntentRequest,
    ) -> Result<GatewayTxResponse, String> {
        self.post_signed_intent("/gateway/create-deal-evm", req)
            .await
    }

    pub async fn update_deal_content_from_evm(
        &self,
        req: SignedIntentRequest,
    ) -> Result<GatewayTxResponse, String> {
        self.post_signed_intent("/gateway/update-deal-content-evm", req)
            .await
    }

    async fn post_signed_intent(
        &self,
        path: &str,
        req: SignedIntentRequest,
    ) -> Result<GatewayTxResponse, String> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let resp = self
            .client
            .post(url)
            .json(&req)
            .send()
            .await
            .map_err(|err| format!("intent request failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("intent failed: {}", resp.status()));
        }
        resp.json::<GatewayTxResponse>()
            .await
            .map_err(|err| format!("invalid intent payload: {err}"))
    }
}
