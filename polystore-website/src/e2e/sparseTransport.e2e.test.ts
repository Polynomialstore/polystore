import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'

import { buildCreateDealTypedData } from '../lib/eip712'
import { postSparseArtifact } from '../lib/upload/sparseTransport'

const DEFAULT_EIP712_CHAIN_ID = Number(process.env.POLYSTORE_EIP712_CHAIN_ID ?? 20260211)
const COSMOS_CHAIN_ID = process.env.POLYSTORE_COSMOS_CHAIN_ID ?? '31337'
const MDU_SIZE = 8 * 1024 * 1024
const MANIFEST_SIZE = 128 * 1024
const VALID_MANIFEST_ROOT =
  '0x85f0ae2fcfd15f3a37873f6d9315f8065df1846d65c5501ebbc6b31d510dcedb0e03001784b59572b58085b39416aed3'

function asViemTypedData<T extends { domain: { chainId: number } }>(typedData: T) {
  return {
    ...typedData,
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
  }
}

async function resolveEip712ChainId(lcdBase: string): Promise<number> {
  try {
    const res = await fetch(`${lcdBase}/polystorechain/polystorechain/v1/params`)
    if (!res.ok) return DEFAULT_EIP712_CHAIN_ID
    const json = (await res.json().catch(() => null)) as { params?: { eip712_chain_id?: string | number } } | null
    const raw = json?.params?.eip712_chain_id
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EIP712_CHAIN_ID
  } catch {
    return DEFAULT_EIP712_CHAIN_ID
  }
}

async function createDeal(gatewayBase: string): Promise<string> {
  const lcdBase = process.env.POLYSTORE_LCD_BASE ?? 'http://localhost:1317'
  const eip712ChainId = await resolveEip712ChainId(lcdBase)
  const account = privateKeyToAccount(
    (process.env.POLYSTORE_E2E_PRIVKEY ??
      '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1') as `0x${string}`,
  )

  const dealIntent = {
    creator_evm: account.address,
    duration_seconds: 100,
    service_hint: 'General',
    initial_escrow: '1',
    max_monthly_spend: '10',
    nonce: Date.now(),
  }
  const dealTyped = asViemTypedData(buildCreateDealTypedData(dealIntent, eip712ChainId)) as Parameters<
    typeof account.signTypedData
  >[0]
  const dealSig = await account.signTypedData(dealTyped)

  const createRes = await fetch(`${gatewayBase}/gateway/create-deal-evm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: { ...dealIntent, chain_id: COSMOS_CHAIN_ID },
      evm_signature: dealSig,
    }),
  })
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => '')
    assert.fail(txt || `create-deal-evm failed (${createRes.status})`)
  }
  const createJson = (await createRes.json()) as { deal_id?: string | number }
  assert.ok(createJson.deal_id, 'expected deal_id in response')
  return String(createJson.deal_id)
}

test(
  'e2e: sparse provider endpoints accept truncated manifest, mdu, and shard bodies',
  { skip: process.env.POLYSTORE_E2E !== '1' },
  async () => {
    const gatewayBase = process.env.POLYSTORE_GATEWAY_BASE ?? 'http://localhost:8080'
    const providerBase = process.env.POLYSTORE_PROVIDER_BASE ?? 'http://127.0.0.1:8082'
    const dealId = await createDeal(gatewayBase)
    const manifestRoot = VALID_MANIFEST_ROOT

    const manifestRes = await postSparseArtifact({
      url: `${providerBase}/sp/upload_manifest`,
      headers: {
        'X-PolyStore-Deal-ID': dealId,
        'X-PolyStore-Manifest-Root': manifestRoot,
      },
      artifact: {
        kind: 'manifest',
        bytes: Uint8Array.from([0x7a, 0x19, 0x00, 0x00]),
        fullSize: MANIFEST_SIZE,
      },
    })
    assert.equal(manifestRes.status, 200, `manifest upload failed: ${await manifestRes.text()}`)

    const mduRes = await postSparseArtifact({
      url: `${providerBase}/sp/upload_mdu`,
      headers: {
        'X-PolyStore-Deal-ID': dealId,
        'X-PolyStore-Manifest-Root': manifestRoot,
        'X-PolyStore-Mdu-Index': '0',
      },
      artifact: {
        kind: 'mdu',
        index: 0,
        bytes: Uint8Array.from([0x33, 0x44, 0x00, 0x00]),
        fullSize: MDU_SIZE,
      },
    })
    assert.equal(mduRes.status, 200, `mdu upload failed: ${await mduRes.text()}`)

    const shardRes = await postSparseArtifact({
      url: `${providerBase}/sp/upload_shard`,
      headers: {
        'X-PolyStore-Deal-ID': dealId,
        'X-PolyStore-Manifest-Root': manifestRoot,
        'X-PolyStore-Mdu-Index': '1',
        'X-PolyStore-Slot': '2',
      },
      artifact: {
        kind: 'shard',
        index: 1,
        slot: 2,
        bytes: Uint8Array.from([0x51, 0x61, 0x71, 0x00, 0x00]),
        fullSize: 4096,
      },
    })
    assert.equal(shardRes.status, 200, `shard upload failed: ${await shardRes.text()}`)
  },
)
