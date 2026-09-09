#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CertificateRenewalTest(unittest.TestCase):
    def run_renewal(self, fail_reload=False):
        with tempfile.TemporaryDirectory() as raw:
            temp = Path(raw)
            calls = temp / "calls"
            token = temp / "cloudflare.env"
            token.write_text("CLOUDFLARE_API_TOKEN=test-token\n")
            token.chmod(0o600)
            config = temp / "Caddyfile"
            config.write_text("{}\n")
            cert_dir = temp / "lego/certificates"
            cert_dir.mkdir(parents=True)
            (cert_dir / "sp1.example.crt").write_text("cert")
            (cert_dir / "sp1.example.key").write_text("key")

            def stub(name, body):
                path = temp / name
                path.write_text("#!/bin/sh\nset -eu\n" + body)
                path.chmod(0o755)
                return path

            lego = stub("lego-bin", f'printf "lego %s\\n" "$*" >>"{calls}"\n')
            setfacl = stub("setfacl", f'printf "setfacl %s\\n" "$*" >>"{calls}"\n')
            caddy = stub(
                "caddy",
                f'printf "caddy %s\\n" "$*" >>"{calls}"\n'
                + ("exit 9\n" if fail_reload else ""),
            )
            env = os.environ.copy()
            env.update(
                POLYSTORE_CERT_TOKEN_ENV_FILE=str(token),
                POLYSTORE_LEGO_BIN=str(lego),
                POLYSTORE_LEGO_PATH=str(temp / "lego"),
                POLYSTORE_LEGO_EMAIL="ops@example.com",
                POLYSTORE_CERT_NAME="sp1.example",
                POLYSTORE_CERT_DOMAINS="sp1.example sp2.example",
                POLYSTORE_SETFACL_BIN=str(setfacl),
                POLYSTORE_CADDY_BIN=str(caddy),
                POLYSTORE_CADDY_CONFIG=str(config),
            )
            result = subprocess.run(
                [str(ROOT / "scripts/renew_provider_certificates.sh")],
                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            return result, calls.read_text()

    def test_renews_applies_acl_and_reloads(self):
        result, calls = self.run_renewal()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("--email ops@example.com", calls)
        self.assertIn("--domains sp1.example --domains sp2.example renew --days 30 --no-random-sleep", calls)
        self.assertIn("setfacl -m u:caddy:r", calls)
        self.assertIn("caddy reload --config", calls)

    def test_reload_failure_fails_closed(self):
        result, calls = self.run_renewal(fail_reload=True)
        self.assertEqual(result.returncode, 9, result.stdout)
        self.assertIn("caddy reload --config", calls)
        self.assertNotIn("completed", result.stdout)


if __name__ == "__main__":
    unittest.main()
