import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = new URL('../../../', import.meta.url)

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, { encoding: 'utf8' })
  chmodSync(path, 0o755)
}

function runProviderScriptTest(opts: {
  command: 'link' | 'pair'
  scenario: 'missing-no-faucet' | 'missing-then-funded'
  autoFaucet: '0' | '1'
  faucetUrl?: string
  keyState?: 'present' | 'missing'
}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'nil-provider-script-test-'))
  const binDir = join(tempDir, 'bin')
  const stateDir = join(tempDir, 'state')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const txLog = join(stateDir, 'tx.log')
  const keyFlag = join(stateDir, 'provider-key.ready')
  const nilchaindStub = join(binDir, 'nilchaind')
  const curlStub = join(binDir, 'curl')

  if ((opts.keyState ?? 'present') === 'present') {
    writeFileSync(keyFlag, 'ready\n', { encoding: 'utf8' })
  }

  writeExecutable(
    nilchaindStub,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "nilchaind stub: missing command" >&2
  exit 1
fi

cmd="$1"
shift
case "$cmd" in
  keys)
    sub="$1"
    shift
    case "$sub" in
      show)
        if [ ! -f "\${NIL_TEST_KEY_FLAG:?}" ]; then
          exit 1
        fi
        printf '%s\\n' "\${NIL_TEST_PROVIDER_ADDR:-nil1providerstubaddr0000000000000000000000000}"
        ;;
      add)
        : >"\${NIL_TEST_KEY_FLAG:?}"
        echo "stub mnemonic words words words" >&2
        ;;
      *)
        echo "nilchaind stub: unsupported keys subcommand: $sub" >&2
        exit 1
        ;;
    esac
    ;;
  tx)
    if [ "$#" -ge 2 ] && [ "$1" = "nilchain" ] && [ "$2" = "request-provider-link" ]; then
      printf 'tx nilchain request-provider-link %s\\n' "$3" >>"\${NIL_TEST_TX_LOG:?}"
      exit 0
    fi
    echo "nilchaind stub: unsupported tx invocation: $*" >&2
    exit 1
    ;;
  *)
    echo "nilchaind stub: unsupported command: $cmd" >&2
    exit 1
    ;;
esac
`,
  )

  writeExecutable(
    curlStub,
    `#!/usr/bin/env bash
set -euo pipefail

scenario="\${NIL_TEST_CURL_SCENARIO:-missing-no-faucet}"
state_dir="\${NIL_TEST_STATE_DIR:?}"
funded_flag="$state_dir/funded"

url=""
wants_status_code=0
fails_on_http=0

for arg in "$@"; do
  if [[ "$arg" == http://* || "$arg" == https://* ]]; then
    url="$arg"
  fi
  if [ "$arg" = "-w" ]; then
    wants_status_code=1
  fi
  if [[ "$arg" == "-f" || "$arg" == *"f"* && "$arg" == -* ]]; then
    fails_on_http=1
  fi
done

if [ -z "$url" ]; then
  echo "curl stub: missing url" >&2
  exit 2
fi

http_code="500"
body='{"error":"unexpected-url"}'

case "$url" in
  */nilchain/nilchain/v1/provider-pairings/*)
    http_code="404"
    body='{"code":5,"message":"not found"}'
    ;;
  */cosmos/bank/v1beta1/balances/*/by_denom\\?denom=aatom)
    if [ "$scenario" = "missing-then-funded" ] && [ -f "$funded_flag" ]; then
      http_code="200"
      body='{"balance":{"denom":"aatom","amount":"1000000"}}'
    else
      http_code="404"
      body='{"code":5,"message":"account not found"}'
    fi
    ;;
  */faucet)
    if [ "$scenario" = "missing-then-funded" ]; then
      : >"$funded_flag"
      http_code="200"
      body='{"tx_hash":"0xstub"}'
    else
      http_code="403"
      body='{"error":"faucet disabled"}'
    fi
    ;;
esac

if [ "$wants_status_code" = "1" ]; then
  printf '%s' "$http_code"
  exit 0
fi

if [ "$fails_on_http" = "1" ] && [[ ! "$http_code" =~ ^2 ]]; then
  exit 22
fi

printf '%s' "$body"
`,
  )

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    PROVIDER_KEY: 'provider1',
    OPERATOR_ADDRESS: 'nil1operatorstub0000000000000000000000000000',
    NILCHAIND_BIN: nilchaindStub,
    NIL_TEST_PROVIDER_ADDR: 'nil1providerstub0000000000000000000000000',
    NIL_TEST_KEY_FLAG: keyFlag,
    NIL_TEST_TX_LOG: txLog,
    NIL_TEST_CURL_SCENARIO: opts.scenario,
    NIL_TEST_STATE_DIR: stateDir,
    NIL_PROVIDER_AUTO_FAUCET: opts.autoFaucet,
    NIL_FAUCET_URL: opts.faucetUrl ?? '',
    NIL_FAUCET_AUTH_TOKEN: '',
    HUB_LCD: 'http://stub-lcd.local',
    HUB_NODE: 'http://stub-rpc.local',
    CHAIN_ID: 'nilchain-stub',
    POLYSTORE_TESTNET_ENV_FILE: '/dev/null',
  }

  const result = spawnSync('./scripts/run_devnet_provider.sh', [opts.command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  })

  let txLogContent = ''
  try {
    txLogContent = readFileSync(txLog, 'utf8')
  } catch {
    txLogContent = ''
  }

  rmSync(tempDir, { recursive: true, force: true })
  return {
    ...result,
    combinedOutput: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    txLogContent,
  }
}

test('run_devnet_provider link fails with actionable funding guidance when provider has no gas funds', () => {
  const result = runProviderScriptTest({
    command: 'link',
    scenario: 'missing-no-faucet',
    autoFaucet: '0',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.combinedOutput, /provider account has no spendable aatom/i)
  assert.match(result.combinedOutput, /Fund this provider address with aatom/i)
  assert.match(result.combinedOutput, /tx bank send <funded-key-or-address>/i)
  assert.equal(result.txLogContent.trim(), '')
})

test('run_devnet_provider link auto-funds from faucet then submits provider-link tx', () => {
  const result = runProviderScriptTest({
    command: 'link',
    scenario: 'missing-then-funded',
    autoFaucet: '1',
    faucetUrl: 'https://faucet.nilstore.test/faucet',
  })

  assert.equal(result.status, 0)
  assert.match(result.combinedOutput, /Faucet funding request accepted/i)
  assert.match(result.combinedOutput, /Provider account funded/i)
  assert.match(result.combinedOutput, /Requesting provider link on-chain/i)
  assert.match(result.txLogContent, /tx nilchain request-provider-link nil1operatorstub/)
})

test('run_devnet_provider pair creates a missing key, auto-funds it, and submits provider-link tx', () => {
  const result = runProviderScriptTest({
    command: 'pair',
    scenario: 'missing-then-funded',
    autoFaucet: '1',
    faucetUrl: 'https://faucet.nilstore.test/faucet',
    keyState: 'missing',
  })

  assert.equal(result.status, 0)
  assert.match(result.combinedOutput, /Creating provider key: provider1/i)
  assert.match(result.combinedOutput, /Provider key was created for this run/i)
  assert.match(result.combinedOutput, /Faucet funding request accepted/i)
  assert.match(result.combinedOutput, /Provider account funded/i)
  assert.match(result.combinedOutput, /Requesting provider link on-chain/i)
  assert.match(result.txLogContent, /tx nilchain request-provider-link nil1operatorstub/)
})
