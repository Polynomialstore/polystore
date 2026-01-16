import { invoke } from "@tauri-apps/api/core";

export type GatewayStatusResponse = {
  version: string;
  git_sha: string;
  build_time: string;
  mode: string;
  listening_addr: string;
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
  duration_blocks: number;
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

export async function gatewayStart(): Promise<GatewayStartResponse> {
  return invoke("gateway_start", {
    config: {
      listen_addr: "127.0.0.1:8080",
    },
  });
}

export async function gatewayStatus(): Promise<GatewayStatusResponse> {
  return invoke("gateway_status");
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
