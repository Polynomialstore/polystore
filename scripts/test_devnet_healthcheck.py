#!/usr/bin/env python3
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
ADDRESS = "nil1expectedprovider"
PRECOMPILE = "0x0000000000000000000000000000000000000900"
PRECOMPILE_ERROR = "computeRetrievalSessionIds: sessions is empty"
PRECOMPILE_ERROR_DATA = (
    "0x08c379a0" + f"{32:064x}{len(PRECOMPILE_ERROR):064x}"
    + PRECOMPILE_ERROR.encode().hex().ljust(128, "0")
)


class Handler(BaseHTTPRequestHandler):
    heights = 0
    stalled = False
    wrong_id = False
    wrong_provider = False
    lcd_reachable = True
    evm_530 = False
    inactive_precompile = False
    inactive_provider = False
    provider_eligible = True
    collateral_provider = ADDRESS
    stale_endpoint_first = False
    wrong_endpoint_port = False
    omit_safelisted_methods = False
    missing_lcd_expose = False
    missing_lcd_height = False
    mismatched_lcd_height = False
    missing_provider_headers = False
    retrieval_status = 400
    retrieval_cors = True
    gateway_upload_status = 400
    gateway_upload_error = "invalid deal_id"
    gateway_upload_cors = True
    provider_upload_status = 400
    provider_upload_body = 'invalid deal_id\n'
    provider_upload_cors = True
    faucet_status = 400
    faucet_body = "Invalid request\n"
    faucet_cors = True
    faucet_auth_header = True
    extra_provider = False
    extra_draining_provider = False
    public_base = ""
    duplicate_origin = False

    def send_header(self, keyword, value):
        super().send_header(keyword, value)
        if self.duplicate_origin and keyword.lower() == 'access-control-allow-origin':
            super().send_header(keyword, value)

    def log_message(self, _format, *_args):
        pass

    def send_json(self, value, status=200, cors=False, expose=False, browser_cors=False):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        if cors:
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-methods", "POST, OPTIONS")
            self.send_header("access-control-allow-headers", "content-type")
        if browser_cors:
            self.send_header("access-control-allow-origin", "*")
        if expose:
            self.send_header("access-control-expose-headers", "x-cosmos-block-height")
            if not self.missing_lcd_height:
                requested = self.headers.get("x-cosmos-block-height", "")
                actual = requested or str(self.heights or 10)
                if self.mismatched_lcd_height and requested:
                    actual = str(int(requested) + 1)
                self.send_header("x-cosmos-block-height", actual)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("access-control-allow-origin", "*")
        method = self.headers.get("Access-Control-Request-Method")
        # Keep EVM's older, stricter probe unchanged; vary the general probe.
        omit_method = self.omit_safelisted_methods and self.path != "/"
        self.send_header("access-control-allow-methods", "OPTIONS" if omit_method else f"{method}, OPTIONS")
        if self.path.startswith("/sp/retrieval/mdu/"):
            allowed = "x-polystore-session-id"
            if not self.missing_provider_headers:
                allowed += ", x-polystore-start-blob-index, x-polystore-blob-count"
            self.send_header("access-control-allow-headers", allowed)
        elif self.path == "/polystorechain/polystorechain/v1/params":
            self.send_header("access-control-allow-headers", "x-cosmos-block-height")
        elif self.path == "/faucet":
            allowed = "content-type" + (", x-polystore-faucet-auth" if self.faucet_auth_header else "")
            self.send_header("access-control-allow-headers", allowed)
        else:
            self.send_header("access-control-allow-headers", "content-type")
        self.end_headers()

    def do_GET(self):
        chain_id = "999" if self.wrong_id else "20260211"
        if self.headers.get("x-cosmos-block-height") == "1":
            self.send_json({"error": "height pruned"}, 410)
            return
        if self.path == "/status":
            if not self.stalled:
                type(self).heights += 1
            self.send_json({
                "result": {
                    "node_info": {"network": chain_id},
                    "sync_info": {"latest_block_height": str(self.heights or 10), "catching_up": False},
                },
                "persona": "provider-daemon",
                "provider": {
                    "address": "nil1wrong" if self.wrong_provider else ADDRESS,
                    "chain_id": chain_id,
                    "public_base": self.public_base,
                },
                "deps": {"lcd_reachable": self.lcd_reachable},
            })
        elif self.path == "/cosmos/base/tendermint/v1beta1/node_info":
            self.send_json({"default_node_info": {"network": chain_id}})
        elif self.path == "/polystorechain/polystorechain/v1/params":
            self.send_json({"params": {
                "eip712_chain_id": chain_id,
                "retrieval_v2_activation_height": "1",
                "min_provider_bond": {"amount": "150", "denom": "stake"},
                "storage_price": "1", "retrieval_price_per_blob": {"amount": "1"},
            }}, expose=not self.missing_lcd_expose, browser_cors=True)
        elif self.path == "/cosmos/evm/vm/v1/params":
            self.send_json({"params": {
                "evm_denom": "aatom",
                "active_static_precompiles": [] if self.inactive_precompile else [PRECOMPILE],
            }})
        elif self.path == "/cosmos/consensus/v1/params":
            self.send_json({"params": {"block": {"max_gas": "192000000", "max_bytes": "2097152"}}})
        elif self.path == "/cosmos/bank/v1beta1/denoms_metadata/aatom":
            self.send_json({"metadata": {"base": "aatom"}})
        elif self.path == f"/polystorechain/polystorechain/v1/providers/{ADDRESS}":
            port = 443 if self.wrong_endpoint_port else self.server.server_port
            endpoints = [f"/dns4/localhost/tcp/{port}/https"]
            if self.stale_endpoint_first:
                endpoints.insert(0, "/ip4/127.0.0.1/tcp/8091/http")
            self.send_json({"provider": {
                "address": ADDRESS, "endpoints": endpoints,
                "status": "Jailed" if self.inactive_provider else "Active", "draining": False,
            }})
        elif self.path == f"/polystorechain/polystorechain/v1/providers/{ADDRESS}/collateral":
            self.send_json({"collateral": {
                "provider": self.collateral_provider,
                "eligible_for_new_assignment": self.provider_eligible,
            }})
        elif self.path == "/polystorechain/polystorechain/v1/providers":
            providers = [{"address": ADDRESS, "status": "Active", "draining": False}]
            if self.extra_provider or self.extra_draining_provider:
                providers.append({"address": "nil1unexpected", "status": "Active", "draining": self.extra_draining_provider})
            self.send_json({"providers": providers})
        elif self.path.startswith("/sp/retrieval/mdu/"):
            self.send_json(
                {"error": "invalid session_id" if self.retrieval_status == 400 else "handler unavailable"},
                self.retrieval_status, browser_cors=self.retrieval_cors,
            )
        elif self.path == "/health":
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == '/sp/retrieval/upload?deal_id=invalid':
            assert int(self.headers.get('content-length', '0')) == 0
            self.send_response(self.provider_upload_status)
            self.send_header('content-type', 'text/plain; charset=utf-8')
            if self.provider_upload_cors:
                self.send_header('access-control-allow-origin', '*')
            self.end_headers()
            self.wfile.write(self.provider_upload_body.encode())
            return
        if self.path == "/faucet":
            assert self.rfile.read(int(self.headers.get("content-length", "0"))) == b"{"
            self.send_response(self.faucet_status)
            self.send_header("content-type", "text/plain; charset=utf-8")
            if self.faucet_cors:
                self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(self.faucet_body.encode())
            return
        if self.evm_530:
            self.send_json({"error": "edge unavailable"}, 530, cors=True)
            return
        if self.path.startswith("/gateway/upload?"):
            self.send_json(
                {"error": self.gateway_upload_error}, self.gateway_upload_status,
                browser_cors=self.gateway_upload_cors,
            )
            return
        request = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        result = "0x3e7" if request.get("method") == "eth_chainId" and self.wrong_id else "0x1352573"
        if request.get("method") == "eth_call":
            self.send_json({
                "jsonrpc": "2.0", "id": 1,
                "error": {
                    "code": 3,
                    "message": f"execution reverted: {PRECOMPILE_ERROR}",
                    "data": PRECOMPILE_ERROR_DATA,
                },
            }, cors=True)
            return
        self.send_json({"jsonrpc": "2.0", "id": 1, "result": result}, cors=True)


class PublicHealthcheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        temp = Path(cls.temp.name)
        config = temp / "openssl.cnf"
        config.write_text("""
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=localhost
[v3]
subjectAltName=DNS:localhost
""")
        cls.cert = temp / "cert.pem"
        cls.key = temp / "key.pem"
        cls.chain_cli = temp / "polystorechaind"
        cls.chain_cli.write_text("""#!/bin/sh
if [ "$1 $2 $3" = "tx nilchain --help" ]; then echo 'nilchain transactions subcommands'; exit 0; fi
if [ "$1 $2 $3 $4" = "tx nilchain register-provider --help" ]; then echo '--endpoint --bond'; exit 0; fi
if [ "$1 $2 $4" = "tx nilchain --help" ]; then exit 0; fi
exit 1
""")
        cls.chain_cli.chmod(0o755)
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
            "-keyout", str(cls.key), "-out", str(cls.cert), "-config", str(config),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        Handler.public_base = f"https://localhost:{cls.server.server_port}"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.temp.cleanup()

    def setUp(self):
        Handler.heights = 10
        Handler.stalled = False
        Handler.wrong_id = False
        Handler.wrong_provider = False
        Handler.lcd_reachable = True
        Handler.evm_530 = False
        Handler.inactive_precompile = False
        Handler.inactive_provider = False
        Handler.provider_eligible = True
        Handler.collateral_provider = ADDRESS
        Handler.stale_endpoint_first = False
        Handler.wrong_endpoint_port = False
        Handler.omit_safelisted_methods = False
        Handler.missing_lcd_expose = False
        Handler.missing_lcd_height = False
        Handler.mismatched_lcd_height = False
        Handler.missing_provider_headers = False
        Handler.retrieval_status = 400
        Handler.retrieval_cors = True
        Handler.gateway_upload_status = 400
        Handler.gateway_upload_error = "invalid deal_id"
        Handler.gateway_upload_cors = True
        Handler.provider_upload_status = 400
        Handler.provider_upload_body = 'invalid deal_id\n'
        Handler.provider_upload_cors = True
        Handler.faucet_status = 400
        Handler.faucet_body = "Invalid request\n"
        Handler.faucet_cors = True
        Handler.faucet_auth_header = True
        Handler.extra_provider = False
        Handler.extra_draining_provider = False
        Handler.duplicate_origin = False

    def run_check(self, chain_cli=False, consensus_profile=None):
        base = Handler.public_base
        env = os.environ.copy()
        env.update(
            POLYSTORE_TLS_CA_FILE=str(self.cert),
            SSL_CERT_FILE=str(self.cert),
            CURL_CA_BUNDLE=str(self.cert),
        )
        command = [
            str(ROOT / "scripts/devnet_healthcheck.sh"), "hub", "--public",
            "--rpc", base, "--lcd", base, "--evm", base, "--gateway", base, "--faucet", base,
            "--browser-origin", "https://web.example",
            "--expected-cosmos-chain-id", "20260211", "--expected-evm-chain-id", "20260211",
            "--expected-eip712-chain-id", "20260211", "--polystore-precompile", PRECOMPILE,
            "--expected-evm-denom", "aatom", "--consensus-profile",
            str(consensus_profile or ROOT / "scripts/retrieval_consensus_profile.json"),
            "--expected-min-provider-bond", "150stake",
            "--expected-provider", f"{ADDRESS}|{base}|/dns4/localhost/tcp/{443 if Handler.wrong_endpoint_port else self.server.server_port}/https",
            "--block-wait", "1", "--tls-min-valid-days", "0",
        ]
        if chain_cli:
            command += ["--chain-cli", str(self.chain_cli)]
        return subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def test_public_check_rejects_malformed_consensus_profile_before_network(self):
        profile = Path(self.temp.name) / "bad-profile.json"
        profile.write_text('{"block":{"max_gas":128000000,"max_bytes":"2097152"}}')
        result = self.run_check(consensus_profile=profile)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical decimal string", result.stdout)

    def test_public_check_accepts_lowercase_cors_and_false_catching_up(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_public_check_detects_nilchain_cli_surface(self):
        result = self.run_check(chain_cli=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("module=nilchain", result.stdout)

    def test_public_check_rejects_http_530(self):
        Handler.evm_530 = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("got 530", result.stdout)

    def test_public_check_rejects_duplicate_cors_origins(self):
        Handler.duplicate_origin = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Access-Control-Allow-Origin', result.stdout)
        self.assertIn('Gateway upload POST missing matching Access-Control-Allow-Origin', result.stdout)
        self.assertIn(f'Provider {ADDRESS} upload POST missing matching Access-Control-Allow-Origin', result.stdout)

    def test_public_check_rejects_wrong_chain_id(self):
        Handler.wrong_id = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("chain identity mismatch", result.stdout)

    def test_public_check_rejects_stalled_blocks(self):
        Handler.stalled = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("chain did not advance", result.stdout)

    def test_public_check_rejects_wrong_provider_backend(self):
        Handler.wrong_provider = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("public identity mismatch", result.stdout)

    def test_public_check_requires_provider_lcd_reachability(self):
        for reachable in (False, None, "true"):
            with self.subTest(reachable=reachable):
                Handler.lcd_reachable = reachable
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("cannot reach its configured LCD", result.stdout)

    def test_public_check_rejects_inactive_provider(self):
        Handler.inactive_provider = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not active and serving", result.stdout)

    def test_public_check_requires_explicit_matching_placement_eligibility(self):
        for eligible, address in ((False, ADDRESS), (None, ADDRESS), ("true", ADDRESS), (True, "nil1other")):
            with self.subTest(eligible=eligible, address=address):
                Handler.provider_eligible = eligible
                Handler.collateral_provider = address
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("not eligible for new assignments", result.stdout)

    def test_public_check_rejects_stale_endpoint_before_qualified_endpoint(self):
        Handler.stale_endpoint_first = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must advertise qualified endpoint first", result.stdout)

    def test_public_check_rejects_profile_endpoint_different_from_probed_url(self):
        Handler.wrong_endpoint_port = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configured endpoint differs from qualified public_base", result.stdout)

    def test_public_check_accepts_safelisted_methods_without_allow_methods_entry(self):
        Handler.omit_safelisted_methods = True
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_public_check_rejects_inactive_precompile(self):
        Handler.inactive_precompile = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required EVM precompile is inactive", result.stdout)

    def test_public_check_rejects_missing_lcd_exposed_height(self):
        Handler.missing_lcd_expose = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing exposed response header: x-cosmos-block-height", result.stdout)

    def test_public_check_rejects_missing_lcd_height_value(self):
        Handler.missing_lcd_height = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("response header mismatch", result.stdout)
        self.assertIn("actual=missing", result.stdout)

    def test_public_check_rejects_mismatched_lcd_height_value(self):
        Handler.mismatched_lcd_height = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("response header mismatch", result.stdout)

    def test_public_check_rejects_missing_provider_retrieval_headers(self):
        Handler.missing_provider_headers = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing required request headers", result.stdout)

    def test_public_check_rejects_missing_or_failed_retrieval_handler_despite_options(self):
        for status in (404, 500, 200):
            with self.subTest(status=status):
                Handler.retrieval_status = status
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("retrieval GET did not return the expected authorization rejection", result.stdout)

    def test_public_check_rejects_missing_retrieval_get_cors(self):
        Handler.retrieval_cors = False
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("retrieval GET missing matching Access-Control-Allow-Origin", result.stdout)

    def test_public_check_rejects_missing_or_wrong_gateway_upload_handler(self):
        for status, error in ((404, "not found"), (500, "failed"), (200, "invalid deal_id"), (400, "wrong error")):
            with self.subTest(status=status, error=error):
                Handler.gateway_upload_status = status
                Handler.gateway_upload_error = error
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Gateway upload POST did not return the expected deal validation rejection", result.stdout)

    def test_public_check_rejects_missing_gateway_upload_post_cors(self):
        Handler.gateway_upload_cors = False
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Gateway upload POST missing matching Access-Control-Allow-Origin", result.stdout)

    def test_public_check_rejects_missing_or_wrong_provider_upload_handler(self):
        for status, body in ((404, 'not found'), (500, 'failed'), (200, 'invalid deal_id'), (400, 'wrong error')):
            with self.subTest(status=status, body=body):
                Handler.provider_upload_status = status
                Handler.provider_upload_body = body
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'Provider {ADDRESS} upload POST did not return the expected deal validation rejection', result.stdout)

    def test_public_check_rejects_missing_provider_upload_post_cors(self):
        Handler.provider_upload_cors = False
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'Provider {ADDRESS} upload POST missing matching Access-Control-Allow-Origin', result.stdout)

    def test_public_check_rejects_unexpected_active_provider(self):
        Handler.extra_provider = True
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("active provider inventory mismatch", result.stdout)

    def test_public_check_recognizes_access_controlled_faucet(self):
        Handler.faucet_status = 401
        Handler.faucet_body = "Unauthorized\n"
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_public_check_rejects_missing_or_wrong_faucet_despite_health_and_options(self):
        for status, body in ((404, "not found"), (200, "Invalid request"), (400, "wrong error"), (401, '{"error":"forbidden"}')):
            with self.subTest(status=status, body=body):
                Handler.faucet_status, Handler.faucet_body = status, body
                result = self.run_check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Faucet POST did not return the expected", result.stdout)

    def test_public_check_rejects_missing_faucet_cors(self):
        Handler.faucet_cors = False
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Faucet POST missing matching Access-Control-Allow-Origin", result.stdout)

    def test_public_check_rejects_missing_faucet_auth_preflight_header(self):
        Handler.faucet_auth_header = False
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Faucet CORS preflight missing required request headers", result.stdout)

    def test_public_check_allows_additional_draining_provider(self):
        Handler.extra_draining_provider = True
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
