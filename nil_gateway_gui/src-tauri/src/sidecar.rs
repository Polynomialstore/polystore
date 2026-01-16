use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

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

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            base_url: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_base_url(&self, base_url: String) -> Result<(), String> {
        let normalized = normalize_base_url(base_url);
        let mut guard = self
            .base_url
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        *guard = Some(normalized);
        Ok(())
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

        let (listen_addr, base_url) = normalize_listen_addr(
            config
                .listen_addr
                .clone()
                .unwrap_or_else(|| DEFAULT_LISTEN_ADDR.to_string()),
        );
        let binary = resolve_binary_path(&app, config.binary_path.clone(), "nil_gateway")?;
        let args = config.args.unwrap_or_default();

        let mut cmd = Command::new(binary);
        cmd.args(args)
            .env("NIL_LISTEN_ADDR", &listen_addr)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Ok(resource_dir) = app.path().resource_dir() {
            let nil_cli_path = resource_dir.join("bin").join(binary_filename("nil_cli"));
            if is_resource_ready(&nil_cli_path) {
                cmd.env("NIL_CLI_BIN", &nil_cli_path);
            }
            let trusted_setup_path = resource_dir.join("trusted_setup.txt");
            if is_resource_ready(&trusted_setup_path) {
                cmd.env("NIL_TRUSTED_SETUP", &trusted_setup_path);
            }
        }

        if let Some(env) = config.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(|err| format!("spawn failed: {err}"))?;
        let pid = child.id();

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
                for line in reader.lines().map_while(Result::ok) {
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
                for line in reader.lines().map_while(Result::ok) {
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
            *guard = Some(normalize_base_url(base_url));
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
            return Some(normalize_base_url(trimmed.to_string()));
        }
    }

    let marker = "Starting NilStore Gateway/S3 Adapter on ";
    if let Some(pos) = line.find(marker) {
        let addr = line[pos + marker.len()..].trim();
        if !addr.is_empty() {
            return Some(normalize_base_url(addr.to_string()));
        }
    }

    None
}

fn normalize_base_url(value: String) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value
    } else {
        format!("http://{value}")
    }
}

fn normalize_listen_addr(value: String) -> (String, String) {
    if value.starts_with("http://") || value.starts_with("https://") {
        let addr = value
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .to_string();
        (addr, value)
    } else {
        let base_url = format!("http://{value}");
        (value, base_url)
    }
}

fn binary_filename(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn resolve_binary_path(
    app: &AppHandle,
    explicit: Option<String>,
    name: &str,
) -> Result<String, String> {
    if let Some(path) = explicit {
        return Ok(path);
    }

    let filename = binary_filename(name);
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("bin").join(&filename),
            resource_dir.join(&filename),
        ];
        if let Some(found) = candidates
            .iter()
            .find(|path| is_resource_ready(path))
            .map(|path| path.to_path_buf())
        {
            return Ok(found.to_string_lossy().to_string());
        }
    }

    Ok(filename)
}

fn is_resource_ready(path: &Path) -> bool {
    fs::metadata(path)
        .map(|meta| meta.len() > 1024)
        .unwrap_or(false)
}
