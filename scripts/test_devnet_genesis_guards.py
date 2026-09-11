#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def metadata_program():
    source = (ROOT / "scripts/run_devnet_alpha_multi_sp.sh").read_text()
    match = re.search(
        r'ensure_metadata\(\) \{.*?python3 - "\$genesis" .*?<<\'PY\'\n(.*?)\nPY\n\}',
        source,
        re.DOTALL,
    )
    if not match:
        raise AssertionError("ensure_metadata Python program not found")
    return match.group(1)


class DevnetGenesisGuardTest(unittest.TestCase):
    def run_program(self, module_key="nilchain", activation="1", profile=None):
        genesis = {
            "app_state": {
                "bank": {"denom_metadata": [], "supply": []},
                "evm": {"params": {"active_static_precompiles": []}},
                module_key: {"params": {}},
            },
            # Simulate defaults written by collect-gentxs.
            "consensus": {"params": {"block": {"max_bytes": "22020096", "max_gas": "-1"}}},
        }
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "genesis.json"
            path.write_text(json.dumps(genesis))
            profile_path = Path(raw) / "profile.json"
            profile_path.write_text(json.dumps(profile or {
                "block": {"max_bytes": "2097152", "max_gas": "128000000"}}))
            env = os.environ.copy()
            env.update(
                EVM_CHAIN_ID="20260211",
                POLYSTORE_RETRIEVAL_V2_ACTIVATION_HEIGHT=activation,
                POLYSTORE_DEVNET_POLICING_DEFAULTS="1",
                POLYSTORE_DENOM="stake",
            )
            result = subprocess.run(
                ["python3", "-", str(path), str(profile_path),
                 str(ROOT / "scripts")], input=metadata_program(), env=env,
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            return result, json.loads(path.read_text())

    def assert_valid_final_genesis(self, module_key):
        result, genesis = self.run_program(module_key)
        self.assertEqual(result.returncode, 0, result.stderr)
        params = genesis["app_state"][module_key]["params"]
        self.assertEqual(params["eip712_chain_id"], "20260211")
        self.assertEqual(params["retrieval_v2_activation_height"], "1")
        self.assertEqual(params["min_provider_bond"], {"denom": "stake", "amount": "150"})
        self.assertIn(
            "0x0000000000000000000000000000000000000900",
            genesis["app_state"]["evm"]["params"]["active_static_precompiles"],
        )
        self.assertTrue(any(m["base"] == "aatom" for m in genesis["app_state"]["bank"]["denom_metadata"]))
        self.assertEqual(genesis["consensus"]["params"]["block"]["max_gas"], "128000000")
        self.assertEqual(genesis["consensus"]["params"]["block"]["max_bytes"], "2097152")

    def test_final_genesis_current_nilchain_module(self):
        self.assert_valid_final_genesis("nilchain")

    def test_final_genesis_legacy_module_fallback(self):
        self.assert_valid_final_genesis("polystorechain")

    def test_malformed_activation_fails_before_genesis_write(self):
        result, genesis = self.run_program("nilchain", activation="not-a-height")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a non-negative integer", result.stderr)
        self.assertEqual(genesis["consensus"]["params"]["block"]["max_gas"], "-1")

    def test_malformed_profile_fails_before_genesis_write(self):
        result, genesis = self.run_program(profile={
            "block": {"max_bytes": "2097152", "max_gas": 128000000}})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical decimal string", result.stderr)
        self.assertEqual(genesis["consensus"]["params"]["block"]["max_gas"], "-1")


if __name__ == "__main__":
    unittest.main()
