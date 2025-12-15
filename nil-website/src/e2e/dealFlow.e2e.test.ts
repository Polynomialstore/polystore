import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'

import {
  buildCreateDealTypedData,
  buildRetrievalReceiptTypedData,
  buildRetrievalRequestTypedData,
  buildUpdateContentTypedData,
} from '../lib/eip712'
import { ethToNil } from '../lib/address'
import { gatewayFetchSlabLayout, gatewayListFiles } from '../api/gatewayClient'
import { lcdFetchDeals } from '../api/lcdClient'
import { hexToBytes } from '../lib/merkle'

const CHAIN_ID = 31337
const COSMOS_CHAIN_ID = process.env.NIL_COSMOS_CHAIN_ID ?? '31337'

// viem's typed-data helpers require domain.chainId as bigint.
function asViemTypedData<T extends { domain: { chainId: number } }>(typedData: T) {
  return {
    ...typedData,
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
  } as any
}

test(
  'e2e: create deal → upload → commit → slab/files (requires local stack)',
  { skip: process.env.NIL_E2E !== '1' },
  async () => {
    const gatewayBase = process.env.NIL_GATEWAY_BASE ?? 'http://localhost:8080'
    const lcdBase = process.env.NIL_LCD_BASE ?? 'http://localhost:1317'

    const account = privateKeyToAccount(
      (process.env.NIL_E2E_PRIVKEY ??
        '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1') as `0x${string}`,
    )
    const ownerNil = ethToNil(account.address)

    // 1) Create Deal
    const dealIntent = {
      creator_evm: account.address,
      duration_blocks: 100,
      service_hint: 'General:replicas=1',
      initial_escrow: '1000000',
      max_monthly_spend: '5000000',
      nonce: Date.now(),
    }
    const dealTyped = asViemTypedData(buildCreateDealTypedData(dealIntent, CHAIN_ID))
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
    const createJson = (await createRes.json()) as any
    assert.ok(createJson.deal_id, 'expected deal_id in response')
    const dealId = String(createJson.deal_id)

    // 2) Upload file (gateway canonical ingest)
    const content = Buffer.from('hello nilfs\n', 'utf8')
    const form = new FormData()
    form.append('file', new Blob([content]), 'hello.txt')
    form.append('owner', ownerNil)
    form.append('deal_id', dealId)

    const uploadRes = await fetch(`${gatewayBase}/gateway/upload?deal_id=${encodeURIComponent(dealId)}`, {
      method: 'POST',
      body: form,
    })
    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => '')
      assert.fail(txt || `upload failed (${uploadRes.status})`)
    }
    const uploadJson = (await uploadRes.json()) as any
    const manifestRoot = String(uploadJson.manifest_root ?? uploadJson.cid ?? '')
    assert.ok(manifestRoot, 'expected manifest_root from upload')

    // 3) Commit content
    const updateIntent = {
      creator_evm: account.address,
      deal_id: Number(dealId),
      cid: manifestRoot,
      size_bytes: Number(uploadJson.size_bytes ?? 0),
      nonce: Date.now() + 1,
    }
    const updateTyped = asViemTypedData(buildUpdateContentTypedData(updateIntent, CHAIN_ID))
    const updateSig = await account.signTypedData(updateTyped)

    const updateRes = await fetch(`${gatewayBase}/gateway/update-deal-content-evm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: { ...updateIntent, chain_id: COSMOS_CHAIN_ID },
        evm_signature: updateSig,
      }),
    })
    if (!updateRes.ok) {
      const txt = await updateRes.text().catch(() => '')
      assert.fail(txt || `update-deal-content-evm failed (${updateRes.status})`)
    }

    // 4) Verify slab layout + file list via the same TS clients used by the UI.
    const slab = await gatewayFetchSlabLayout(gatewayBase, manifestRoot, { dealId, owner: ownerNil })
    assert.ok(slab.total_mdus >= 1)
    assert.equal(slab.manifest_root, manifestRoot)

    const files = await gatewayListFiles(gatewayBase, manifestRoot, { dealId, owner: ownerNil })
    assert.equal(files.some((f) => f.path === 'hello.txt'), true)

    // 5) Verify deal shows committed CID on LCD (best-effort; may take a moment).
    let saw = false
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const deals = await lcdFetchDeals(lcdBase).catch(() => [])
      const found = deals.find((d) => d.id === dealId)
      if (found && found.cid === manifestRoot) {
        saw = true
        break
      }
    }
    assert.equal(saw, true, 'expected LCD deal to reflect committed content')

    // 6) Fetch a small range + submit an interactive receipt (proves the "deal_id" wiring).
    const filePath = 'hello.txt'
    const rangeStart = 0
    const rangeLen = content.byteLength

    const nonceUrl = `${lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(
      dealId,
    )}/receipt-nonce?file_path=${encodeURIComponent(filePath)}`
    const nonceRes = await fetch(nonceUrl)
    if (!nonceRes.ok) {
      const txt = await nonceRes.text().catch(() => '')
      assert.fail(txt || `receipt-nonce failed (${nonceRes.status})`)
    }
    const nonceJson = (await nonceRes.json()) as any
    const lastNonce = Number(nonceJson.last_nonce ?? 0) || 0
    assert.equal(lastNonce, 0)

    const expiresAt = Math.floor(Date.now() / 1000) + 120
    const reqNonce = Math.floor(Math.random() * 0xffffffff) || 1
    const reqIntent = {
      deal_id: Number(dealId),
      file_path: filePath,
      range_start: rangeStart,
      range_len: rangeLen,
      nonce: reqNonce,
      expires_at: expiresAt,
    }
    const reqTyped = asViemTypedData(buildRetrievalRequestTypedData(reqIntent, CHAIN_ID))
    const reqSig = await account.signTypedData(reqTyped)

    const fetchUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(
      manifestRoot,
    )}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(ownerNil)}&file_path=${encodeURIComponent(
      filePath,
    )}`
    const fetchRes = await fetch(fetchUrl, {
      headers: {
        'X-Nil-Req-Sig': reqSig,
        'X-Nil-Req-Nonce': String(reqNonce),
        'X-Nil-Req-Expires-At': String(expiresAt),
        'X-Nil-Req-Range-Start': String(rangeStart),
        'X-Nil-Req-Range-Len': String(rangeLen),
        Range: `bytes=${rangeStart}-${rangeStart + rangeLen - 1}`,
      },
    })
    if (!fetchRes.ok) {
      const txt = await fetchRes.text().catch(() => '')
      assert.fail(txt || `gateway fetch failed (${fetchRes.status})`)
    }
    const fetched = new Uint8Array(await fetchRes.arrayBuffer())
    assert.equal(Buffer.from(fetched).toString('utf8'), Buffer.from(content).toString('utf8'))

    const hDealId = fetchRes.headers.get('X-Nil-Deal-ID')
    const hEpoch = fetchRes.headers.get('X-Nil-Epoch')
    const hProvider = fetchRes.headers.get('X-Nil-Provider')
    const hFilePath = fetchRes.headers.get('X-Nil-File-Path')
    const hRangeStart = fetchRes.headers.get('X-Nil-Range-Start')
    const hRangeLen = fetchRes.headers.get('X-Nil-Range-Len')
    const hBytes = fetchRes.headers.get('X-Nil-Bytes-Served')
    const hProofHash = fetchRes.headers.get('X-Nil-Proof-Hash')
    const hProofJson = fetchRes.headers.get('X-Nil-Proof-JSON')
    const hFetchSession = fetchRes.headers.get('X-Nil-Fetch-Session')
    assert.ok(hDealId, 'missing X-Nil-Deal-ID')
    assert.ok(hEpoch, 'missing X-Nil-Epoch')
    assert.ok(hProvider, 'missing X-Nil-Provider')
    assert.ok(hFilePath, 'missing X-Nil-File-Path')
    assert.ok(hRangeStart, 'missing X-Nil-Range-Start')
    assert.ok(hRangeLen, 'missing X-Nil-Range-Len')
    assert.ok(hBytes, 'missing X-Nil-Bytes-Served')
    assert.ok(hProofHash, 'missing X-Nil-Proof-Hash')
    assert.ok(hProofJson, 'missing X-Nil-Proof-JSON')
    assert.ok(hFetchSession, 'missing X-Nil-Fetch-Session')

    const proofWrapper = JSON.parse(Buffer.from(hProofJson!, 'base64').toString('utf8')) as any
    assert.ok(proofWrapper.proof_details, 'missing proof_details')

    const provider = hProvider!
    const proofHash = hProofHash! as `0x${string}`
    const filePathFromHeaders = hFilePath!

    const receiptNonce = lastNonce + 1
    const receiptIntent = {
      deal_id: Number(hDealId),
      epoch_id: Number(hEpoch),
      provider,
      file_path: filePathFromHeaders,
      range_start: Number(hRangeStart),
      range_len: Number(hRangeLen),
      bytes_served: Number(hBytes),
      nonce: receiptNonce,
      expires_at: 0,
      proof_hash: proofHash,
    }
    const receiptTyped = asViemTypedData(buildRetrievalReceiptTypedData(receiptIntent, CHAIN_ID))
    const receiptSig = await account.signTypedData(receiptTyped)

    const submitRes = await fetch(`${gatewayBase}/gateway/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fetch_session: hFetchSession,
        receipt: {
          deal_id: receiptIntent.deal_id,
          epoch_id: receiptIntent.epoch_id,
          provider: receiptIntent.provider,
          file_path: receiptIntent.file_path,
          range_start: receiptIntent.range_start,
          range_len: receiptIntent.range_len,
          bytes_served: receiptIntent.bytes_served,
          nonce: receiptIntent.nonce,
          expires_at: 0,
          user_signature: Buffer.from(hexToBytes(receiptSig)).toString('base64'),
          proof_details: proofWrapper.proof_details,
        },
      }),
    })
    if (!submitRes.ok) {
      const txt = await submitRes.text().catch(() => '')
      assert.fail(txt || `gateway receipt submission failed (${submitRes.status})`)
    }

    // Verify nonce advanced for (deal_id,file_path).
    let updated = false
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 400))
      const r2 = await fetch(nonceUrl).catch(() => null)
      if (!r2 || !r2.ok) continue
      const j2 = (await r2.json().catch(() => null)) as any
      if (Number(j2?.last_nonce ?? 0) === receiptNonce) {
        updated = true
        break
      }
    }
    assert.equal(updated, true, 'expected receipt nonce to advance after submission')
  },
)
