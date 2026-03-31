import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildStorageAgentPrompt } from './storageOnboarding'

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8').trim()
}

test('buildStorageAgentPrompt matches the canonical repo prompt', () => {
  const prompt = buildStorageAgentPrompt().trim()
  const canonical = readRepoFile('docs/onboarding-prompts/storage.md')

  assert.equal(prompt, canonical)
})

test('buildStorageAgentPrompt captures the current storage onboarding contract', () => {
  const prompt = buildStorageAgentPrompt()

  assert.match(prompt, /Proceed autonomously through repo sync, local checks, Gateway GUI setup/)
  assert.match(prompt, /https:\/\/nilstore\.org\/#\/first-file/)
  assert.match(prompt, /https:\/\/nilstore\.org\/#\/dashboard/)
  assert.match(prompt, /NIL_BURNER_KEYSTORE_PASSWORD/)
  assert.match(prompt, /create_tx_hash/)
  assert.match(prompt, /milestone_fast_bootstrap/)
  assert.match(prompt, /EVM_PRIVKEY/)
})

test('storage quickstart points users at the current route map and password prerequisite', () => {
  const quickstart = readRepoFile('docs/ALPHA_STORAGE_USER_QUICKSTART.md')

  assert.match(quickstart, /https:\/\/nilstore\.org\/#\/first-file/)
  assert.match(quickstart, /#\/dashboard/)
  assert.match(quickstart, /NIL_BURNER_KEYSTORE_PASSWORD/)
  assert.match(quickstart, /EVM_PRIVKEY/)
})
