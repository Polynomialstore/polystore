use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:8080";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub binary_path: Option<String>,
    pub listen_addr: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStartResponse {
    pub base_url: String,
    pub pid: u32,
}

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
    base_url: Arc<Mutex<Option<String>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            base_url: Arc::new(Mutex::new(None)),
        }
    }

    pub fn base_url(&self) -> Result<String, String> {
        self.base_url
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "gateway not started".to_string())
    }

    pub async fn start(
        &self,
        app: AppHandle,
        config: GatewayConfig,
    ) -> Result<GatewayStartResponse, String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        if let Some(child) = guard.as_ref() {
            let base_url = self.base_url()?;
            return Ok(GatewayStartResponse {
                base_url,
                pid: child.id(),
            });
        }

        let listen_addr = config
            .listen_addr
            .clone()
            .unwrap_or_else(|| DEFAULT_LISTEN_ADDR.to_string());
        let binary = config
            .binary_path
            .clone()
            .unwrap_or_else(|| "nil_gateway".to_string());
        let args = config.args.unwrap_or_default();

        let mut cmd = Command::new(binary);
        cmd.args(args)
            .env("NIL_LISTEN_ADDR", &listen_addr)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(env) = config.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(|err| format!("spawn failed: {err}"))?;
        let pid = child.id();

        let base_url = format!("http://{listen_addr}");
        {
            let mut guard = self
                .base_url
                .lock()
                .map_err(|_| "sidecar lock poisoned".to_string())?;
            *guard = Some(base_url.clone());
        }

        if let Some(stdout) = child.stdout.take() {
            let app_handle = app.clone();
            let base_url_handle = Arc::clone(&self.base_url);
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    emit_log(&app_handle, &line);
                    if let Some(url) = parse_listening_addr(&line) {
                        if let Ok(mut lock) = base_url_handle.lock() {
                            *lock = Some(url);
                        }
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    emit_log(&app_handle, &line);
                }
            });
        }

        *guard = Some(child);
        Ok(GatewayStartResponse { base_url, pid })
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
        if let Ok(mut base_url) = self.base_url.lock() {
            *base_url = None;
        }
        Ok(())
    }

    pub fn set_base_url_for_tests(&self, base_url: String) {
        if let Ok(mut guard) = self.base_url.lock() {
            *guard = Some(base_url);
        }
    }
}

fn emit_log(app: &AppHandle, line: &str) {
    let _ = app.emit("gateway_log", line);
}

fn parse_listening_addr(line: &str) -> Option<String> {
    if let Some(value) = line.strip_prefix("LISTENING_ADDR=") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(format!("http://{trimmed}"));
        }
    }

    let marker = "Starting NilStore Gateway/S3 Adapter on ";
    if let Some(pos) = line.find(marker) {
        let addr = line[pos + marker.len()..].trim();
        if !addr.is_empty() {
            return Some(format!("http://{addr}"));
        }
    }

    None
}
