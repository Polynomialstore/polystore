use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpNetworkDefaults {
    pub chain_id: String,
    pub hub_lcd: String,
    pub hub_node: String,
    pub provider_listen: String,
    pub provider_base_url: String,
    pub provider_capabilities: String,
    pub provider_total_storage: String,
    pub endpoint_mode_default: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpKeyInfo {
    pub alias: String,
    pub address: String,
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpBalanceCheckRequest {
    pub hub_lcd: String,
    pub address: String,
    pub denom: Option<String>,
    pub min_recommended: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpBalanceCheckResponse {
    pub ok: bool,
    pub address: String,
    pub denom: String,
    pub amount: String,
    pub min_recommended: String,
    pub sufficient: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpEndpointValidateRequest {
    pub endpoint: String,
    pub mode: Option<String>,
    pub provider_base_url: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpCheckResult {
    pub name: String,
    pub ok: bool,
    pub detail: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpEndpointValidateResponse {
    pub valid: bool,
    pub normalized_endpoint: String,
    pub checks: Vec<SpCheckResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpRegisterProviderRequest {
    pub provider_key: String,
    pub chain_id: String,
    pub hub_lcd: String,
    pub hub_node: String,
    pub provider_endpoint: String,
    pub provider_capabilities: Option<String>,
    pub provider_total_storage: Option<String>,
    pub gas_prices: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpStartProviderRequest {
    pub provider_key: String,
    pub chain_id: String,
    pub hub_lcd: String,
    pub hub_node: String,
    pub provider_listen: String,
    pub shared_auth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpStopProviderRequest {
    pub provider_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpCommandResponse {
    pub ok: bool,
    pub action: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpIssue {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub recommended_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpHealthSnapshotRequest {
    pub chain_id: Option<String>,
    pub hub_lcd: String,
    pub provider_base_url: String,
    pub provider_addr: Option<String>,
    pub provider_key: Option<String>,
    pub shared_auth_present: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpHealthSnapshot {
    pub status: String,
    pub captured_at_unix: u64,
    pub checks: Vec<SpCheckResult>,
    pub issues: Vec<SpIssue>,
    pub provider_base_url: String,
    pub provider_addr: Option<String>,
    pub provider_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpRemoteBundleRequest {
    pub provider_key: String,
    pub chain_id: String,
    pub hub_lcd: String,
    pub hub_node: String,
    pub provider_endpoint: String,
    pub provider_listen: String,
    pub shared_auth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpRemoteBundleResponse {
    pub env_block: String,
    pub init_command: String,
    pub register_command: String,
    pub start_command: String,
    pub stop_command: String,
    pub healthcheck_command: String,
    pub systemd_unit: String,
    pub systemd_env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LcdBalancesResponse {
    balances: Vec<LcdCoin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LcdCoin {
    denom: String,
    amount: String,
}

fn now_unix() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs(),
        Err(_) => 0,
    }
}

fn repo_root() -> Result<PathBuf, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    root.canonicalize()
        .map_err(|err| format!("failed to resolve repo root: {err}"))
}

fn run_provider_script(
    action: &str,
    envs: &HashMap<&str, String>,
) -> Result<SpCommandResponse, String> {
    let root = repo_root()?;
    let mut command = Command::new("bash");
    command
        .arg("-lc")
        .arg(format!("./scripts/run_devnet_provider.sh {action}"))
        .current_dir(root);

    for (key, value) in envs {
        command.env(key, value);
    }

    let output = command
        .output()
        .map_err(|err| format!("failed to run provider script: {err}"))?;

    let exit_code = output.status.code().unwrap_or(-1);
    Ok(SpCommandResponse {
        ok: output.status.success(),
        action: action.to_string(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code,
    })
}

fn parse_provider_address(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("address:") {
            let addr = rest.trim();
            if !addr.is_empty() {
                return Some(addr.to_string());
            }
        }
    }
    None
}

fn validate_multiaddr(endpoint: &str) -> Vec<SpCheckResult> {
    let mut checks = Vec::new();
    let normalized = endpoint.trim();

    let has_prefix = normalized.starts_with("/ip4/") || normalized.starts_with("/dns4/");
    checks.push(SpCheckResult {
        name: "endpoint_prefix".to_string(),
        ok: has_prefix,
        detail: if has_prefix {
            "endpoint starts with /ip4/ or /dns4/".to_string()
        } else {
            "endpoint must start with /ip4/ or /dns4/".to_string()
        },
        severity: if has_prefix {
            "info".to_string()
        } else {
            "error".to_string()
        },
    });

    let has_tcp = normalized.contains("/tcp/");
    checks.push(SpCheckResult {
        name: "endpoint_tcp".to_string(),
        ok: has_tcp,
        detail: if has_tcp {
            "endpoint includes /tcp/<port>".to_string()
        } else {
            "endpoint must include /tcp/<port>".to_string()
        },
        severity: if has_tcp {
            "info".to_string()
        } else {
            "error".to_string()
        },
    });

    let has_http = normalized.ends_with("/http") || normalized.ends_with("/https");
    checks.push(SpCheckResult {
        name: "endpoint_transport".to_string(),
        ok: has_http,
        detail: if has_http {
            "endpoint has /http or /https transport".to_string()
        } else {
            "endpoint should end with /http or /https".to_string()
        },
        severity: if has_http {
            "info".to_string()
        } else {
            "error".to_string()
        },
    });

    checks
}

pub fn network_defaults() -> SpNetworkDefaults {
    SpNetworkDefaults {
        chain_id: std::env::var("CHAIN_ID").unwrap_or_else(|_| "20260211".to_string()),
        hub_lcd: std::env::var("HUB_LCD").unwrap_or_else(|_| "http://127.0.0.1:1317".to_string()),
        hub_node: std::env::var("HUB_NODE").unwrap_or_else(|_| "tcp://127.0.0.1:26657".to_string()),
        provider_listen: std::env::var("PROVIDER_LISTEN").unwrap_or_else(|_| ":8091".to_string()),
        provider_base_url: std::env::var("PROVIDER_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8091".to_string()),
        provider_capabilities: std::env::var("PROVIDER_CAPABILITIES")
            .unwrap_or_else(|_| "General".to_string()),
        provider_total_storage: std::env::var("PROVIDER_TOTAL_STORAGE")
            .unwrap_or_else(|_| "1099511627776".to_string()),
        endpoint_mode_default: "direct".to_string(),
    }
}

pub async fn key_create(alias: String) -> Result<SpKeyInfo, String> {
    let mut envs = HashMap::new();
    envs.insert("PROVIDER_KEY", alias.clone());

    let response = run_provider_script("init", &envs)?;
    let address = parse_provider_address(&response.stdout).unwrap_or_default();

    Ok(SpKeyInfo {
        alias,
        address,
        ok: response.ok,
        stdout: response.stdout,
        stderr: response.stderr,
        exit_code: response.exit_code,
    })
}

pub async fn balance_check(req: SpBalanceCheckRequest) -> Result<SpBalanceCheckResponse, String> {
    let denom = req.denom.unwrap_or_else(|| "aatom".to_string());
    let min_recommended = req.min_recommended.unwrap_or_else(|| "1000000".to_string());
    let min = min_recommended.parse::<u128>().unwrap_or(1_000_000);

    let base = req.hub_lcd.trim_end_matches('/');
    let url = format!("{base}/cosmos/bank/v1beta1/balances/{}", req.address);

    let response = Client::new()
        .get(url)
        .send()
        .await
        .map_err(|err| format!("balance check request failed: {err}"))?;

    if !response.status().is_success() {
        return Err(format!("balance check failed: {}", response.status()));
    }

    let payload = response
        .json::<LcdBalancesResponse>()
        .await
        .map_err(|err| format!("invalid balance payload: {err}"))?;

    let amount = payload
        .balances
        .into_iter()
        .find(|coin| coin.denom == denom)
        .map(|coin| coin.amount)
        .unwrap_or_else(|| "0".to_string());

    let parsed = amount.parse::<u128>().unwrap_or(0);
    let sufficient = parsed >= min;

    Ok(SpBalanceCheckResponse {
        ok: true,
        address: req.address,
        denom,
        amount,
        min_recommended,
        sufficient,
        detail: if sufficient {
            "provider account has enough gas for registration".to_string()
        } else {
            "insufficient gas balance for provider registration".to_string()
        },
    })
}

pub async fn endpoint_validate(
    req: SpEndpointValidateRequest,
) -> Result<SpEndpointValidateResponse, String> {
    let normalized = req.endpoint.trim().to_string();
    let mut checks = validate_multiaddr(&normalized);

    if let Some(base) = req.provider_base_url {
        let target = format!("{}/health", base.trim_end_matches('/'));
        let timeout_secs = req.timeout_secs.unwrap_or(4);
        let probe = Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|err| format!("failed to build http client: {err}"))?
            .get(&target)
            .send()
            .await;

        match probe {
            Ok(resp) => checks.push(SpCheckResult {
                name: "provider_health_probe".to_string(),
                ok: resp.status().is_success(),
                detail: format!("GET {target} -> {}", resp.status()),
                severity: if resp.status().is_success() {
                    "info".to_string()
                } else {
                    "warn".to_string()
                },
            }),
            Err(err) => checks.push(SpCheckResult {
                name: "provider_health_probe".to_string(),
                ok: false,
                detail: format!("GET {target} failed: {err}"),
                severity: "warn".to_string(),
            }),
        }
    }

    let valid = checks
        .iter()
        .all(|check| check.ok || check.severity != "error");

    Ok(SpEndpointValidateResponse {
        valid,
        normalized_endpoint: normalized,
        checks,
    })
}

pub async fn register_provider(
    req: SpRegisterProviderRequest,
) -> Result<SpCommandResponse, String> {
    let mut envs = HashMap::new();
    envs.insert("PROVIDER_KEY", req.provider_key);
    envs.insert("CHAIN_ID", req.chain_id);
    envs.insert("HUB_LCD", req.hub_lcd);
    envs.insert("HUB_NODE", req.hub_node);
    envs.insert("PROVIDER_ENDPOINT", req.provider_endpoint);
    envs.insert(
        "PROVIDER_CAPABILITIES",
        req.provider_capabilities
            .unwrap_or_else(|| "General".to_string()),
    );
    envs.insert(
        "PROVIDER_TOTAL_STORAGE",
        req.provider_total_storage
            .unwrap_or_else(|| "1099511627776".to_string()),
    );
    envs.insert(
        "NIL_GAS_PRICES",
        req.gas_prices.unwrap_or_else(|| "0.001aatom".to_string()),
    );

    run_provider_script("register", &envs)
}

pub async fn start_provider_local(
    req: SpStartProviderRequest,
) -> Result<SpCommandResponse, String> {
    let mut envs = HashMap::new();
    envs.insert("PROVIDER_KEY", req.provider_key);
    envs.insert("CHAIN_ID", req.chain_id);
    envs.insert("HUB_LCD", req.hub_lcd);
    envs.insert("HUB_NODE", req.hub_node);
    envs.insert("PROVIDER_LISTEN", req.provider_listen);
    envs.insert("NIL_GATEWAY_SP_AUTH", req.shared_auth);

    run_provider_script("start", &envs)
}

pub async fn stop_provider_local(req: SpStopProviderRequest) -> Result<SpCommandResponse, String> {
    let mut envs = HashMap::new();
    envs.insert("PROVIDER_KEY", req.provider_key);
    run_provider_script("stop", &envs)
}

pub async fn health_snapshot(req: SpHealthSnapshotRequest) -> Result<SpHealthSnapshot, String> {
    let mut checks = Vec::<SpCheckResult>::new();
    let mut issues = Vec::<SpIssue>::new();

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|err| format!("failed to build health client: {err}"))?;

    let provider_health_url = format!("{}/health", req.provider_base_url.trim_end_matches('/'));
    match client.get(&provider_health_url).send().await {
        Ok(resp) if resp.status().is_success() => checks.push(SpCheckResult {
            name: "provider_health".to_string(),
            ok: true,
            detail: format!("{} -> {}", provider_health_url, resp.status()),
            severity: "info".to_string(),
        }),
        Ok(resp) => {
            checks.push(SpCheckResult {
                name: "provider_health".to_string(),
                ok: false,
                detail: format!("{} -> {}", provider_health_url, resp.status()),
                severity: "error".to_string(),
            });
            issues.push(SpIssue {
                code: "service_down".to_string(),
                severity: "critical".to_string(),
                message: "provider health endpoint is not healthy".to_string(),
                recommended_action: "Start/restart provider service and verify listen endpoint."
                    .to_string(),
            });
        }
        Err(err) => {
            checks.push(SpCheckResult {
                name: "provider_health".to_string(),
                ok: false,
                detail: format!("{} request failed: {}", provider_health_url, err),
                severity: "error".to_string(),
            });
            issues.push(SpIssue {
                code: "service_down".to_string(),
                severity: "critical".to_string(),
                message: "provider health endpoint is unreachable".to_string(),
                recommended_action: "Ensure provider process is running and endpoint is reachable."
                    .to_string(),
            });
        }
    }

    let lcd_base = req.hub_lcd.trim_end_matches('/');
    let params_url = format!("{lcd_base}/polystorechain/polystorechain/v1/params");
    match client.get(&params_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            checks.push(SpCheckResult {
                name: "lcd_reachable".to_string(),
                ok: true,
                detail: format!("{} -> {}", params_url, resp.status()),
                severity: "info".to_string(),
            });
        }
        Ok(resp) => {
            checks.push(SpCheckResult {
                name: "lcd_reachable".to_string(),
                ok: false,
                detail: format!("{} -> {}", params_url, resp.status()),
                severity: "error".to_string(),
            });
            issues.push(SpIssue {
                code: "chain_unreachable".to_string(),
                severity: "critical".to_string(),
                message: "hub LCD is unreachable from this machine".to_string(),
                recommended_action: "Check HUB_LCD value and network connectivity.".to_string(),
            });
        }
        Err(err) => {
            checks.push(SpCheckResult {
                name: "lcd_reachable".to_string(),
                ok: false,
                detail: format!("{} request failed: {}", params_url, err),
                severity: "error".to_string(),
            });
            issues.push(SpIssue {
                code: "chain_unreachable".to_string(),
                severity: "critical".to_string(),
                message: "hub LCD request failed".to_string(),
                recommended_action: "Check HUB_LCD value and ensure the hub is online.".to_string(),
            });
        }
    }

    if let Some(expected_chain_id) = req.chain_id {
        let node_info_url = format!("{lcd_base}/cosmos/base/tendermint/v1beta1/node_info");
        match client.get(&node_info_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let payload = resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or(serde_json::Value::Null);
                let network = payload
                    .get("default_node_info")
                    .and_then(|value| value.get("network"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let match_ok = network == expected_chain_id;
                checks.push(SpCheckResult {
                    name: "chain_id_match".to_string(),
                    ok: match_ok,
                    detail: format!("expected {}, got {}", expected_chain_id, network),
                    severity: if match_ok {
                        "info".to_string()
                    } else {
                        "error".to_string()
                    },
                });
                if !match_ok {
                    issues.push(SpIssue {
                        code: "chain_id_mismatch".to_string(),
                        severity: "critical".to_string(),
                        message: "hub chain id does not match expected chain id".to_string(),
                        recommended_action: "Switch profile defaults to the correct hub chain."
                            .to_string(),
                    });
                }
            }
            Ok(resp) => checks.push(SpCheckResult {
                name: "chain_id_match".to_string(),
                ok: false,
                detail: format!("{} -> {}", node_info_url, resp.status()),
                severity: "warn".to_string(),
            }),
            Err(err) => checks.push(SpCheckResult {
                name: "chain_id_match".to_string(),
                ok: false,
                detail: format!("{} request failed: {}", node_info_url, err),
                severity: "warn".to_string(),
            }),
        }
    }

    if let Some(provider_addr) = req.provider_addr.clone() {
        let provider_url = format!("{lcd_base}/polystorechain/polystorechain/v1/providers/{provider_addr}");
        match client.get(&provider_url).send().await {
            Ok(resp) if resp.status().is_success() => checks.push(SpCheckResult {
                name: "provider_registered".to_string(),
                ok: true,
                detail: format!("{} -> {}", provider_url, resp.status()),
                severity: "info".to_string(),
            }),
            Ok(resp) => {
                checks.push(SpCheckResult {
                    name: "provider_registered".to_string(),
                    ok: false,
                    detail: format!("{} -> {}", provider_url, resp.status()),
                    severity: "warn".to_string(),
                });
                issues.push(SpIssue {
                    code: "provider_unregistered".to_string(),
                    severity: "degraded".to_string(),
                    message: "provider is not visible on chain".to_string(),
                    recommended_action: "Run Register on chain and verify gas funding.".to_string(),
                });
            }
            Err(err) => {
                checks.push(SpCheckResult {
                    name: "provider_registered".to_string(),
                    ok: false,
                    detail: format!("{} request failed: {}", provider_url, err),
                    severity: "warn".to_string(),
                });
                issues.push(SpIssue {
                    code: "provider_unregistered".to_string(),
                    severity: "degraded".to_string(),
                    message: "provider registration check failed".to_string(),
                    recommended_action: "Re-run registration and validate provider address."
                        .to_string(),
                });
            }
        }
    }

    if req.shared_auth_present == Some(false) {
        issues.push(SpIssue {
            code: "auth_mismatch".to_string(),
            severity: "critical".to_string(),
            message: "shared auth token is missing".to_string(),
            recommended_action: "Set NIL_GATEWAY_SP_AUTH to the hub-provided token.".to_string(),
        });
        checks.push(SpCheckResult {
            name: "shared_auth_present".to_string(),
            ok: false,
            detail: "shared auth token not provided".to_string(),
            severity: "error".to_string(),
        });
    } else {
        checks.push(SpCheckResult {
            name: "shared_auth_present".to_string(),
            ok: true,
            detail: "shared auth token configured".to_string(),
            severity: "info".to_string(),
        });
    }

    let has_critical = issues.iter().any(|issue| issue.severity == "critical");
    let has_degraded = issues.iter().any(|issue| issue.severity == "degraded");

    let status = if has_critical {
        "critical"
    } else if has_degraded {
        "degraded"
    } else {
        "healthy"
    };

    Ok(SpHealthSnapshot {
        status: status.to_string(),
        captured_at_unix: now_unix(),
        checks,
        issues,
        provider_base_url: req.provider_base_url,
        provider_addr: req.provider_addr,
        provider_key: req.provider_key,
    })
}

pub fn generate_remote_bundle(req: SpRemoteBundleRequest) -> SpRemoteBundleResponse {
    let env_block = format!(
        "export CHAIN_ID=\"{}\"\nexport HUB_LCD=\"{}\"\nexport HUB_NODE=\"{}\"\nexport PROVIDER_KEY=\"{}\"\nexport PROVIDER_ENDPOINT=\"{}\"\nexport PROVIDER_LISTEN=\"{}\"\nexport NIL_GATEWAY_SP_AUTH=\"{}\"",
        req.chain_id,
        req.hub_lcd,
        req.hub_node,
        req.provider_key,
        req.provider_endpoint,
        req.provider_listen,
        req.shared_auth
    );

    let init_command =
        "PROVIDER_KEY=$PROVIDER_KEY ./scripts/run_devnet_provider.sh init".to_string();
    let register_command = "PROVIDER_KEY=$PROVIDER_KEY PROVIDER_ENDPOINT=$PROVIDER_ENDPOINT CHAIN_ID=$CHAIN_ID HUB_LCD=$HUB_LCD HUB_NODE=$HUB_NODE ./scripts/run_devnet_provider.sh register".to_string();
    let start_command = "PROVIDER_KEY=$PROVIDER_KEY CHAIN_ID=$CHAIN_ID HUB_LCD=$HUB_LCD HUB_NODE=$HUB_NODE PROVIDER_LISTEN=$PROVIDER_LISTEN NIL_GATEWAY_SP_AUTH=$NIL_GATEWAY_SP_AUTH ./scripts/run_devnet_provider.sh start".to_string();
    let stop_command =
        "PROVIDER_KEY=$PROVIDER_KEY ./scripts/run_devnet_provider.sh stop".to_string();
    let healthcheck_command = "scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1${PROVIDER_LISTEN} --hub-lcd $HUB_LCD".to_string();

    let systemd_unit = r#"[Unit]
Description=NilStore Provider Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/dev/nil-store/nil-store
EnvironmentFile=%h/.config/polystore-provider.env
ExecStart=/usr/bin/env bash -lc 'PROVIDER_KEY=${PROVIDER_KEY} CHAIN_ID=${CHAIN_ID} HUB_LCD=${HUB_LCD} HUB_NODE=${HUB_NODE} PROVIDER_LISTEN=${PROVIDER_LISTEN} NIL_GATEWAY_SP_AUTH=${NIL_GATEWAY_SP_AUTH} ./scripts/run_devnet_provider.sh start'
ExecStop=/usr/bin/env bash -lc 'PROVIDER_KEY=${PROVIDER_KEY} ./scripts/run_devnet_provider.sh stop'
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target"#
        .to_string();

    let systemd_env = format!(
        "CHAIN_ID={}\nHUB_LCD={}\nHUB_NODE={}\nPROVIDER_KEY={}\nPROVIDER_ENDPOINT={}\nPROVIDER_LISTEN={}\nNIL_GATEWAY_SP_AUTH={}",
        req.chain_id,
        req.hub_lcd,
        req.hub_node,
        req.provider_key,
        req.provider_endpoint,
        req.provider_listen,
        req.shared_auth
    );

    SpRemoteBundleResponse {
        env_block,
        init_command,
        register_command,
        start_command,
        stop_command,
        healthcheck_command,
        systemd_unit,
        systemd_env,
    }
}
