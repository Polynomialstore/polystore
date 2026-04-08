use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:8080";
const TRUSTED_GATEWAY_PORT: u16 = 8080;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStorageFileEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_unix: i64,
    pub deal_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStorageDealEntry {
    pub deal_id: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub manifest_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStorageSummary {
    pub gateway_dir: String,
    pub uploads_dir: String,
    pub session_db_path: String,
    pub session_db_exists: bool,
    pub total_files: u64,
    pub total_bytes: u64,
    pub deal_count: u64,
    pub manifest_count: u64,
    pub deal_entries: Vec<GatewayStorageDealEntry>,
    pub recent_files: Vec<GatewayStorageFileEntry>,
}

#[derive(Debug, Clone)]
struct GatewayStoragePaths {
    gateway_dir: PathBuf,
    uploads_dir: PathBuf,
    session_db_path: PathBuf,
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
        if !is_trusted_local_gateway_base(&normalized) {
            return Err(format!(
                "untrusted gateway endpoint {normalized}; expected localhost/127.0.0.1 on port {TRUSTED_GATEWAY_PORT}"
            ));
        }
        let mut guard = self
            .base_url
            .lock()
            .map_err(|_| "gateway lock poisoned".to_string())?;
        *guard = Some(normalized);
        Ok(())
    }

    pub fn base_url(&self) -> Result<String, String> {
        self.base_url
            .lock()
            .map_err(|_| "gateway lock poisoned".to_string())?
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
            .map_err(|_| "gateway lock poisoned".to_string())?;
        if self.running_child(&mut guard)? {
            let base_url = self.base_url()?;
            return Ok(GatewayStartResponse {
                base_url,
                pid: guard.as_ref().map_or(0, Child::id),
            });
        }

        if guard.is_some() {
            guard.take();
        }

        let (listen_addr, base_url) = normalize_listen_addr(
            config
                .listen_addr
                .clone()
                .unwrap_or_else(|| DEFAULT_LISTEN_ADDR.to_string()),
        );
        if !is_trusted_local_gateway_base(&base_url) {
            return Err(format!(
                "desktop gateway listen address must stay on localhost/127.0.0.1:{TRUSTED_GATEWAY_PORT}; got {base_url}"
            ));
        }
        if is_listening_addr_in_use(&listen_addr) {
            return Err(format!(
                "address {listen_addr} is already in use by another process. Stop external gateway first or choose a different listen address."
            ));
        }

        let binary = resolve_binary_path(&app, config.binary_path.clone(), "polystore_gateway")?;
        let args = config.args.unwrap_or_default();

        let mut cmd = Command::new(&binary);
        cmd.args(args)
            .env("NIL_LISTEN_ADDR", &listen_addr)
            .env("NIL_RUNTIME_PERSONA", "user-gateway")
            .env("NIL_ALLOW_PROVIDER_ON_USER_PORT", "0")
            // Local desktop Gateway default: keep libp2p disabled unless explicitly enabled.
            // This avoids startup collisions on hosts already running router/provider daemons.
            .env("NIL_P2P_ENABLED", "0")
            // Desktop local-cache UX: allow sessionless chunked /gateway/fetch downloads.
            // Browser "auto source" uses this for cached files to avoid on-chain retrieval tx popups.
            .env("NIL_REQUIRE_ONCHAIN_SESSION", "0")
            // Local desktop mode should import directly from user-selected files by default.
            .env("NIL_LOCAL_IMPORT_ENABLED", "1")
            .env("NIL_LOCAL_IMPORT_ALLOW_ABS", "1")
            // Local desktop Gateway should not run synthetic system-liveness ticks unless
            // explicitly requested. Those ticks need provider key material and create noisy logs.
            .env("NIL_DISABLE_SYSTEM_LIVENESS", "1")
            // Defensive: ensure leaked shell env cannot make this process behave like provider-daemon.
            .env_remove("NIL_PROVIDER_KEY")
            .env_remove("NIL_PROVIDER_ADDRESS")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Ensure gateway writable state is always under a per-user app data dir.
        // This avoids macOS app-translocation/read-only bundle paths when the
        // sidecar would otherwise default to relative "uploads/".
        configure_sidecar_storage_env(&app, &mut cmd);

        // First, derive runtime env from the resolved gateway binary path itself.
        // This makes packaged Linux installs robust even when resource_dir resolution
        // differs across distros/layouts.
        configure_sidecar_from_binary_layout(&mut cmd, &binary);

        if let Ok(resource_dir) = app.path().resource_dir() {
            let polystore_cli_path = resource_dir.join("bin").join(binary_filename("polystore_cli"));
            if is_resource_ready(&polystore_cli_path) {
                cmd.env("NIL_CLI_BIN", &polystore_cli_path);
            }
            for trusted_setup_path in [
                resource_dir.join("bin").join("trusted_setup.txt"),
                resource_dir.join("trusted_setup.txt"),
            ] {
                if is_resource_ready(&trusted_setup_path) {
                    cmd.env("NIL_TRUSTED_SETUP", &trusted_setup_path);
                    break;
                }
            }
            configure_sidecar_runtime_env(&mut cmd, &resource_dir);
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
                .map_err(|_| "gateway lock poisoned".to_string())?;
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

        // Catch immediate startup failures (for example port collisions) and surface
        // a concrete error to the UI instead of failing later on status probe.
        std::thread::sleep(Duration::from_millis(350));
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("failed to check gateway status: {err}"))?
        {
            if let Ok(mut base_url) = self.base_url.lock() {
                *base_url = None;
            }
            return Err(format!(
                "gateway exited during startup (status: {status}). Check logs for bind/lib dependency errors."
            ));
        }

        *guard = Some(child);
        Ok(GatewayStartResponse { base_url, pid })
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "gateway lock poisoned".to_string())?;
        if !self.running_child(&mut guard)? {
            return Err(
                "No managed Gateway process is currently running under this GUI session."
                    .to_string(),
            );
        }
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
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

    pub fn is_managed(&self) -> Result<bool, String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| "gateway lock poisoned".to_string())?;
        self.running_child(&mut guard)
    }

    fn running_child(&self, guard: &mut Option<Child>) -> Result<bool, String> {
        let Some(child) = guard.as_mut() else {
            return Ok(false);
        };

        match child
            .try_wait()
            .map_err(|err| format!("failed to check gateway status: {err}"))?
        {
            Some(_) => {
                guard.take();
                Ok(false)
            }
            None => Ok(true),
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

fn is_listening_addr_in_use(listen_addr: &str) -> bool {
    let Ok(addrs) = listen_addr.to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return true;
        }
    }
    false
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

fn is_trusted_local_gateway_base(value: &str) -> bool {
    let parsed = match reqwest::Url::parse(value) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    if !is_loopback {
        return false;
    }
    parsed.port_or_known_default() == Some(TRUSTED_GATEWAY_PORT)
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
    let mut resource_roots: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        resource_roots.push(resource_dir);
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            // Debian/Ubuntu install layout:
            //   /usr/bin/polystore_gateway_gui -> /usr/lib/polystore_gateway_gui/bin/polystore_gateway
            resource_roots.push(exe_dir.join("..").join("lib").join("polystore_gateway_gui"));
        }
    }

    resource_roots.push(PathBuf::from("/usr/lib/polystore_gateway_gui"));

    for root in resource_roots {
        let candidates = [root.join("bin").join(&filename), root.join(&filename)];
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

fn has_any_resource(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| is_resource_ready(&dir.join(name)))
}

fn extend_env_path_list(cmd: &mut Command, key: &str, dir: &Path) {
    let mut paths: Vec<PathBuf> = vec![dir.to_path_buf()];
    if let Some(existing) = env::var_os(key) {
        paths.extend(env::split_paths(&existing));
    }
    if let Ok(joined) = env::join_paths(paths) {
        cmd.env(key, joined);
    }
}

fn configure_sidecar_runtime_env(cmd: &mut Command, resource_dir: &Path) {
    let bin_dir = resource_dir.join("bin");
    configure_sidecar_runtime_env_for_bin_dir(cmd, &bin_dir);
}

fn configure_sidecar_runtime_env_for_bin_dir(cmd: &mut Command, bin_dir: &Path) {
    #[cfg(target_os = "linux")]
    if has_any_resource(bin_dir, &["libpolystore_core.so"]) {
        extend_env_path_list(cmd, "LD_LIBRARY_PATH", bin_dir);
    }

    #[cfg(target_os = "macos")]
    if has_any_resource(bin_dir, &["libpolystore_core.dylib"]) {
        extend_env_path_list(cmd, "DYLD_LIBRARY_PATH", bin_dir);
    }

    #[cfg(target_os = "windows")]
    if has_any_resource(bin_dir, &["polystore_core.dll", "libpolystore_core.dll"]) {
        extend_env_path_list(cmd, "PATH", bin_dir);
    }
}

fn configure_sidecar_storage_env(app: &AppHandle, cmd: &mut Command) {
    let Some(paths) = resolve_gateway_storage_paths(app) else {
        return;
    };

    if fs::create_dir_all(&paths.uploads_dir).is_err() {
        return;
    }

    // Keep process cwd in a known writable location for any relative fallback paths.
    cmd.current_dir(&paths.gateway_dir);
    cmd.env("NIL_UPLOAD_DIR", &paths.uploads_dir);
    cmd.env("NIL_SESSION_DB_PATH", &paths.session_db_path);
}

fn configure_sidecar_from_binary_layout(cmd: &mut Command, binary: &str) {
    let binary_path = PathBuf::from(binary);
    if !binary_path.is_absolute() {
        return;
    }

    let Some(bin_dir) = binary_path.parent() else {
        return;
    };

    let polystore_cli_path = bin_dir.join(binary_filename("polystore_cli"));
    if is_resource_ready(&polystore_cli_path) {
        cmd.env("NIL_CLI_BIN", &polystore_cli_path);
    }

    for trusted_setup_path in {
        let mut candidates = vec![bin_dir.join("trusted_setup.txt")];
        if let Some(root_dir) = bin_dir.parent() {
            candidates.push(root_dir.join("trusted_setup.txt"));
        }
        candidates
    } {
        if is_resource_ready(&trusted_setup_path) {
            cmd.env("NIL_TRUSTED_SETUP", &trusted_setup_path);
            break;
        }
    }

    configure_sidecar_runtime_env_for_bin_dir(cmd, bin_dir);
}

fn resolve_gateway_storage_paths(app: &AppHandle) -> Option<GatewayStoragePaths> {
    let base_dir = app
        .path()
        .app_data_dir()
        .ok()
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".nilstore")))?;

    let gateway_dir = base_dir.join("gateway");
    let uploads_dir = gateway_dir.join("uploads");
    let session_db_path = uploads_dir.join("sessions.db");
    Some(GatewayStoragePaths {
        gateway_dir,
        uploads_dir,
        session_db_path,
    })
}

fn parse_deal_id(parts: &[String]) -> String {
    if parts.len() >= 2 && parts[0] == "deals" {
        return parts[1].clone();
    }
    "unscoped".to_string()
}

fn parse_manifest_key(parts: &[String]) -> Option<(String, String)> {
    if parts.len() >= 3 && parts[0] == "deals" {
        return Some((parts[1].clone(), parts[2].clone()));
    }
    None
}

pub fn local_storage_summary(app: &AppHandle) -> Result<GatewayStorageSummary, String> {
    let Some(paths) = resolve_gateway_storage_paths(app) else {
        return Err("unable to resolve local gateway storage path".to_string());
    };
    fs::create_dir_all(&paths.uploads_dir)
        .map_err(|err| format!("failed to ensure uploads directory exists: {err}"))?;

    #[derive(Default)]
    struct DealAgg {
        file_count: u64,
        total_bytes: u64,
    }

    let mut total_files: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut deal_aggs: HashMap<String, DealAgg> = HashMap::new();
    let mut manifest_keys: HashSet<String> = HashSet::new();
    let mut recent_files: Vec<GatewayStorageFileEntry> = Vec::new();

    let mut stack = vec![paths.uploads_dir.clone()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };

            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }

            total_files += 1;
            let size = meta.len();
            total_bytes += size;

            let rel = path
                .strip_prefix(&paths.uploads_dir)
                .unwrap_or(path.as_path())
                .to_path_buf();
            let rel_str = rel.to_string_lossy().to_string();
            let rel_parts: Vec<String> = rel
                .iter()
                .map(|part| part.to_string_lossy().to_string())
                .collect();
            let deal_id = parse_deal_id(&rel_parts);

            if let Some((deal, manifest)) = parse_manifest_key(&rel_parts) {
                manifest_keys.insert(format!("{deal}::{manifest}"));
            }

            let agg = deal_aggs.entry(deal_id.clone()).or_default();
            agg.file_count += 1;
            agg.total_bytes += size;

            let modified_unix = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
                .unwrap_or(0);

            recent_files.push(GatewayStorageFileEntry {
                relative_path: rel_str,
                size_bytes: size,
                modified_unix,
                deal_id,
            });
        }
    }

    let mut manifest_count_by_deal: HashMap<String, u64> = HashMap::new();
    for key in &manifest_keys {
        if let Some((deal_id, _)) = key.split_once("::") {
            *manifest_count_by_deal
                .entry(deal_id.to_string())
                .or_insert(0) += 1;
        }
    }

    let mut deal_entries: Vec<GatewayStorageDealEntry> = deal_aggs
        .into_iter()
        .map(|(deal_id, agg)| GatewayStorageDealEntry {
            manifest_count: manifest_count_by_deal.get(&deal_id).copied().unwrap_or(0),
            deal_id,
            file_count: agg.file_count,
            total_bytes: agg.total_bytes,
        })
        .collect();
    deal_entries.sort_by(|a, b| {
        b.total_bytes
            .cmp(&a.total_bytes)
            .then_with(|| b.file_count.cmp(&a.file_count))
            .then_with(|| a.deal_id.cmp(&b.deal_id))
    });

    recent_files.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    recent_files.truncate(12);

    Ok(GatewayStorageSummary {
        gateway_dir: paths.gateway_dir.to_string_lossy().to_string(),
        uploads_dir: paths.uploads_dir.to_string_lossy().to_string(),
        session_db_path: paths.session_db_path.to_string_lossy().to_string(),
        session_db_exists: paths.session_db_path.exists(),
        total_files,
        total_bytes,
        deal_count: u64::try_from(deal_entries.len()).unwrap_or(u64::MAX),
        manifest_count: u64::try_from(manifest_keys.len()).unwrap_or(u64::MAX),
        deal_entries,
        recent_files,
    })
}
