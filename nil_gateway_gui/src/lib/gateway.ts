import { invoke } from "@tauri-apps/api/core";

export type GatewayStatusResponse = {
  version: string;
  git_sha: string;
  build_time: string;
  persona?: string;
  mode: string;
  allowed_route_families?: string[];
  listening_addr: string;
  managed?: boolean;
  provider_base?: string;
  p2p_addrs?: string[];
  capabilities: Record<string, boolean>;
  deps: Record<string, boolean>;
  extra?: Record<string, string>;
};

export type GatewayStartResponse = {
  base_url: string;
  pid: number;
};

export type GatewayCreateDealIntent = {
  creator_evm: string;
  duration_seconds: number;
  service_hint: string;
  initial_escrow: string;
  max_monthly_spend: string;
  nonce: number;
  chain_id: string;
};

export type GatewayUpdateContentIntent = {
  creator_evm: string;
  deal_id: number;
  cid: string;
  size_bytes: number;
  total_mdus: number;
  witness_mdus: number;
  nonce: number;
  chain_id: string;
};

export type GatewayTxResponse = {
  status?: string;
  tx_hash: string;
  deal_id?: string;
};

export type GatewayUploadResponse = {
  cid: string;
  manifest_root: string;
  size_bytes: number;
  file_size_bytes: number;
  allocated_length: number;
  total_mdus: number;
  witness_mdus: number;
  filename: string;
  upload_id: string;
};

export type GatewayFileEntry = {
  path: string;
  size_bytes: number;
  start_offset: number;
  flags: number;
};

export type GatewayStorageFileEntry = {
  relative_path: string;
  size_bytes: number;
  modified_unix: number;
  deal_id: string;
};

export type GatewayStorageDealEntry = {
  deal_id: string;
  file_count: number;
  total_bytes: number;
  manifest_count: number;
};

export type GatewayStorageSummary = {
  gateway_dir: string;
  uploads_dir: string;
  session_db_path: string;
  session_db_exists: boolean;
  total_files: number;
  total_bytes: number;
  deal_count: number;
  manifest_count: number;
  deal_entries: GatewayStorageDealEntry[];
  recent_files: GatewayStorageFileEntry[];
};

export type GatewayListFilesResponse = {
  manifest_root: string;
  total_size_bytes: number;
  files: GatewayFileEntry[];
};

export type BridgeStartResponse = {
  request_id: string;
  url: string;
};

export type SpDeploymentMode = "local" | "remote";
export type SpEndpointMode = "direct" | "cloudflare_tunnel";

export type SpNetworkDefaults = {
  chain_id: string;
  hub_lcd: string;
  hub_node: string;
  provider_listen: string;
  provider_base_url: string;
  provider_capabilities: string;
  provider_total_storage: string;
  endpoint_mode_default: SpEndpointMode;
};

export type SpKeyInfo = {
  alias: string;
  address: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
};

export type SpBalanceCheckRequest = {
  hub_lcd: string;
  address: string;
  denom?: string;
  min_recommended?: string;
};

export type SpBalanceCheckResponse = {
  ok: boolean;
  address: string;
  denom: string;
  amount: string;
  min_recommended: string;
  sufficient: boolean;
  detail: string;
};

export type SpCheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  severity: "info" | "warn" | "error";
};

export type SpEndpointValidateRequest = {
  endpoint: string;
  mode?: SpEndpointMode;
  provider_base_url?: string;
  timeout_secs?: number;
};

export type SpEndpointValidateResponse = {
  valid: boolean;
  normalized_endpoint: string;
  checks: SpCheckResult[];
};

export type SpRegisterProviderRequest = {
  provider_key: string;
  chain_id: string;
  hub_lcd: string;
  hub_node: string;
  provider_endpoint: string;
  provider_capabilities?: string;
  provider_total_storage?: string;
  gas_prices?: string;
};

export type SpStartProviderRequest = {
  provider_key: string;
  chain_id: string;
  hub_lcd: string;
  hub_node: string;
  provider_listen: string;
  shared_auth: string;
};

export type SpStopProviderRequest = {
  provider_key: string;
};

export type SpCommandResponse = {
  ok: boolean;
  action: string;
  stdout: string;
  stderr: string;
  exit_code: number;
};

export type SpIssue = {
  code:
    | "chain_unreachable"
    | "chain_id_mismatch"
    | "provider_unregistered"
    | "endpoint_unreachable"
    | "service_down"
    | "auth_mismatch"
    | "insufficient_gas"
    | "endpoint_drift";
  severity: "critical" | "degraded";
  message: string;
  recommended_action: string;
};

export type SpHealthSnapshotRequest = {
  chain_id?: string;
  hub_lcd: string;
  provider_base_url: string;
  provider_addr?: string;
  provider_key?: string;
  shared_auth_present?: boolean;
};

export type SpHealthSnapshot = {
  status: "healthy" | "degraded" | "critical";
  captured_at_unix: number;
  checks: SpCheckResult[];
  issues: SpIssue[];
  provider_base_url: string;
  provider_addr?: string;
  provider_key?: string;
};

export type SpRemoteBundleRequest = {
  provider_key: string;
  chain_id: string;
  hub_lcd: string;
  hub_node: string;
  provider_endpoint: string;
  provider_listen: string;
  shared_auth: string;
};

export type SpRemoteBundleResponse = {
  env_block: string;
  init_command: string;
  register_command: string;
  start_command: string;
  stop_command: string;
  healthcheck_command: string;
  systemd_unit: string;
  systemd_env: string;
};

export async function gatewayStart(config?: {
  listen_addr?: string;
  env?: Record<string, string>;
}): Promise<GatewayStartResponse> {
  return invoke("gateway_start", {
    config: {
      listen_addr: config?.listen_addr ?? "127.0.0.1:8080",
      env: config?.env ?? undefined,
    },
  });
}

export async function gatewayStatus(): Promise<GatewayStatusResponse> {
  return invoke("gateway_status");
}

export async function gatewayLocalStorage(): Promise<GatewayStorageSummary> {
  return invoke("gateway_local_storage");
}

export async function gatewayStop(): Promise<void> {
  return invoke("gateway_stop");
}

export async function gatewayAttach(baseUrl: string): Promise<void> {
  return invoke("gateway_attach", { baseUrl });
}

export async function walletBridgeStart(
  typedData: unknown,
): Promise<BridgeStartResponse> {
  return invoke("wallet_bridge_start", { typed_data: typedData });
}

export async function walletBridgeWait(requestId: string): Promise<string> {
  return invoke("wallet_bridge_wait", { request_id: requestId });
}

export async function createDealEvm(
  intent: GatewayCreateDealIntent,
  signature: string,
): Promise<GatewayTxResponse> {
  return invoke("deal_create_evm", { intent, signature });
}

export async function updateDealContentEvm(
  intent: GatewayUpdateContentIntent,
  signature: string,
): Promise<GatewayTxResponse> {
  return invoke("deal_update_content_evm", { intent, signature });
}

export async function uploadFile(params: {
  deal_id: number;
  owner: string;
  file_path: string;
  local_path: string;
}): Promise<GatewayUploadResponse> {
  return invoke("deal_upload_file", params);
}

export async function listFiles(params: {
  deal_id: number;
  owner: string;
  manifest_root: string;
}): Promise<GatewayListFilesResponse> {
  return invoke("deal_list_files", params);
}

export async function fetchFile(params: {
  deal_id: number;
  owner: string;
  manifest_root: string;
  file_path: string;
  output_path: string;
}): Promise<void> {
  return invoke("deal_fetch_file", params);
}

export async function spNetworkDefaults(): Promise<SpNetworkDefaults> {
  return invoke("sp_network_defaults");
}

export async function spKeyCreate(alias: string): Promise<SpKeyInfo> {
  return invoke("sp_key_create", { alias });
}

export async function spBalanceCheck(
  req: SpBalanceCheckRequest,
): Promise<SpBalanceCheckResponse> {
  return invoke("sp_balance_check", { req });
}

export async function spValidateEndpoint(
  req: SpEndpointValidateRequest,
): Promise<SpEndpointValidateResponse> {
  return invoke("sp_validate_endpoint", { req });
}

export async function spRegisterProvider(
  req: SpRegisterProviderRequest,
): Promise<SpCommandResponse> {
  return invoke("sp_register_provider", { req });
}

export async function spStartProviderLocal(
  req: SpStartProviderRequest,
): Promise<SpCommandResponse> {
  return invoke("sp_start_provider_local", { req });
}

export async function spStopProviderLocal(
  req: SpStopProviderRequest,
): Promise<SpCommandResponse> {
  return invoke("sp_stop_provider_local", { req });
}

export async function spHealthSnapshot(
  req: SpHealthSnapshotRequest,
): Promise<SpHealthSnapshot> {
  return invoke("sp_health_snapshot", { req });
}

export async function spGenerateRemoteBundle(
  req: SpRemoteBundleRequest,
): Promise<SpRemoteBundleResponse> {
  return invoke("sp_generate_remote_bundle", { req });
}
