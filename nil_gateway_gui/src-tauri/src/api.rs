use reqwest::{multipart, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatusResponse {
    pub version: String,
    pub git_sha: String,
    pub build_time: String,
    pub mode: String,
    pub listening_addr: String,
    pub managed: Option<bool>,
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
struct GatewayUploadAcceptedResponse {
    status: String,
    deal_id: Option<String>,
    upload_id: Option<String>,
    status_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GatewayUploadJobResult {
    manifest_root: Option<String>,
    size_bytes: Option<u64>,
    file_size_bytes: Option<u64>,
    allocated_length: Option<u64>,
    total_mdus: Option<u64>,
    witness_mdus: Option<u64>,
    upload_id: Option<String>,
    file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GatewayUploadJobStatus {
    status: Option<String>,
    result: Option<GatewayUploadJobResult>,
    error: Option<String>,
    message: Option<String>,
}

const GATEWAY_UPLOAD_POLL_INTERVAL: Duration = Duration::from_millis(750);
const GATEWAY_UPLOAD_POLL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

static GATEWAY_UPLOAD_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_upload_id_prefix() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

fn next_upload_id() -> String {
    let seq = GATEWAY_UPLOAD_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("gw-{:x}-{}", now_upload_id_prefix(), seq)
}

fn map_job_outcome(
    upload_id: &str,
    fallback_name: &str,
    result: GatewayUploadJobResult,
) -> Result<GatewayUploadResponse, String> {
    let manifest_root = result
        .manifest_root
        .ok_or_else(|| "missing manifest_root in upload status".to_string())?;
    Ok(GatewayUploadResponse {
        cid: manifest_root.clone(),
        manifest_root,
        size_bytes: result.size_bytes.unwrap_or(0),
        file_size_bytes: result.file_size_bytes.unwrap_or(0),
        allocated_length: result.allocated_length.unwrap_or(0),
        total_mdus: result.total_mdus.unwrap_or(0),
        witness_mdus: result.witness_mdus.unwrap_or(0),
        filename: result
            .file_name
            .unwrap_or_else(|| fallback_name.to_string()),
        upload_id: result.upload_id.unwrap_or_else(|| upload_id.to_string()),
    })
}

fn normalize_status_url(base_url: &str, default_deal_id: u64, upload_id: &str) -> String {
    format!(
        "{}/gateway/upload-status?deal_id={}&upload_id={}",
        base_url.trim_end_matches('/'),
        default_deal_id,
        upload_id
    )
}

fn map_upload_error_message(status: GatewayUploadJobStatus) -> Option<String> {
    status.error.or(status.message)
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
        let upload_id = next_upload_id();
        let url = format!(
            "{}/gateway/upload?deal_id={}&upload_id={}",
            self.base_url.trim_end_matches('/'),
            deal_id,
            upload_id,
        );
        let data = tokio::fs::read(&local_path)
            .await
            .map_err(|err| format!("failed to read file: {err}"))?;
        let filename = Path::new(&local_path)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("upload.bin")
            .to_string();
        let file_name_for_result = filename.clone();
        let part = multipart::Part::bytes(data)
            .file_name(filename)
            .mime_str("application/octet-stream")
            .map_err(|err| format!("invalid multipart: {err}"))?;
        let form = multipart::Form::new()
            .part("file", part)
            .text("owner", owner)
            .text("deal_id", deal_id.to_string())
            .text("file_path", file_path)
            .text("upload_id", upload_id.clone());

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

        if resp.status() == StatusCode::ACCEPTED {
            let accepted = resp
                .json::<GatewayUploadAcceptedResponse>()
                .await
                .map_err(|err| format!("invalid async upload payload: {err}"))?;
            if accepted.status.to_lowercase() != "accepted" {
                return Err("gateway did not return accepted status".to_string());
            }
            let status_id = accepted
                .upload_id
                .filter(|v| !v.trim().is_empty())
                .unwrap_or(upload_id.clone());
            let status_url = accepted
                .status_url
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    let deal_id_value = accepted
                        .deal_id
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(deal_id);
                    normalize_status_url(&self.base_url, deal_id_value, &status_id)
                });
            let outcome = self
                .wait_for_upload_status(&status_url, deal_id, &status_id)
                .await?;
            let mut response = map_job_outcome(&status_id, &file_name_for_result, outcome)?;
            response.upload_id = status_id;
            return Ok(response);
        }

        let response = resp
            .json::<GatewayUploadResponse>()
            .await
            .map_err(|err| format!("invalid upload payload: {err}"))?;
        if response.upload_id.is_empty() {
            return Ok(GatewayUploadResponse {
                upload_id,
                ..response
            });
        }
        Ok(response)
    }

    async fn wait_for_upload_status(
        &self,
        status_url: &str,
        deal_id: u64,
        upload_id: &str,
    ) -> Result<GatewayUploadJobResult, String> {
        let deadline = Instant::now() + GATEWAY_UPLOAD_POLL_TIMEOUT;
        let mut last_error: Option<String> = None;
        loop {
            let status = match self.fetch_upload_status(status_url).await {
                Ok(status) => status,
                Err(err) => {
                    last_error = Some(err);
                    GatewayUploadJobStatus {
                        status: None,
                        result: None,
                        error: None,
                        message: None,
                    }
                }
            };
            let stage = status
                .status
                .clone()
                .unwrap_or_else(|| "running".to_string())
                .to_lowercase();
            match stage.as_str() {
                "success" => {
                    if let Some(result) = status.result {
                        return Ok(result);
                    }
                    return Err("gateway upload succeeded without result payload".to_string());
                }
                "error" => {
                    return Err(map_upload_error_message(status)
                        .unwrap_or_else(|| "gateway upload failed".to_string()));
                }
                "accepted" | "queued" | "running" | "receiving" | "encoding" | "uploading"
                | "done" => {}
                other => {
                    return Err(format!(
                        "gateway upload returned unsupported status '{other}'"
                    ));
                }
            }
            if Instant::now() >= deadline {
                let err = last_error
                    .clone()
                    .unwrap_or_else(|| "gateway upload status timed out".to_string());
                return Err(format!(
                    "gateway upload timed out for deal_id={deal_id} upload_id={upload_id}: {err}"
                ));
            }
            sleep(GATEWAY_UPLOAD_POLL_INTERVAL).await;
        }
    }

    async fn fetch_upload_status(
        &self,
        status_url: &str,
    ) -> Result<GatewayUploadJobStatus, String> {
        let resp = self
            .client
            .get(status_url)
            .send()
            .await
            .map_err(|err| format!("upload status request failed: {err}"))?;
        if !resp.status().is_success() {
            return Err(format!("upload status failed: {}", resp.status()));
        }
        resp.json::<GatewayUploadJobStatus>()
            .await
            .map_err(|err| format!("invalid upload status payload: {err}"))
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
