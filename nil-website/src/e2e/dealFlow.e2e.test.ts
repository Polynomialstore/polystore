import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'

import { buildCreateDealTypedData, buildUpdateContentTypedData } from '../lib/eip712'
import { ethToNil } from '../lib/address'
import { gatewayFetchSlabLayout, gatewayListFiles } from '../api/gatewayClient'
import { lcdFetchDeals } from '../api/lcdClient'

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

    const uploadRes = await fetch(`${gatewayBase}/gateway/upload`, {
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
  },
)
