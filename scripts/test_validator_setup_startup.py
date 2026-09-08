"""Fresh-process validator setup admission; Python stdlib only.

Run with the built daemon and approved setup, with its native library on the
loader path:
    python3 scripts/test_validator_setup_startup.py /path/to/polystorechaind \
        polystorechain/trusted_setup.txt

All homes and malformed setups are disposable. This checks the actual startup
hook before stores/listeners; the retrieval M0 smoke covers a running validator
and committed proofs with the approved setup.
"""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


SETUP_ERROR = "initialize validator KZG trusted setup"


def check(binary, setup):
    approved = setup.read_bytes()
    lines = approved.splitlines()
    if len(lines) < 5:
        raise ValueError("expected the approved trusted setup")
    # Preserve valid point encodings and shape while changing the setup identity.
    lines[2], lines[3] = lines[3], lines[2]
    substituted = b"\n".join(lines) + b"\n"
    if substituted == approved:
        raise ValueError("setup substitution did not change the supplied setup")
    identity_g1 = "c0" + "00" * 47
    identity_g2 = "c0" + "00" * 95

    with tempfile.TemporaryDirectory(prefix="polystore-startup-setup-") as directory:
        root = Path(directory)
        malformed = {
            "missing": None,
            "malformed": b"not a trusted setup\n",
            "truncated": approved[:256],
            "substituted": substituted,
            "identity": ("2\n2\n" + "\n".join([identity_g1] * 2 + [identity_g2] * 2) + "\n").encode(),
        }

        def run(arguments, path, home, executable=binary, cwd=root):
            env = dict(os.environ)
            if path is None:
                env.pop("POLYSTORE_TRUSTED_SETUP", None)
            else:
                env["POLYSTORE_TRUSTED_SETUP"] = str(path)
            return subprocess.run(
                [str(executable), "--home", str(home), *arguments], cwd=cwd,
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, timeout=30,
            )

        def server_untouched(home):
            # SDK client wiring creates client.toml before the root pre-run.
            # Server configuration, databases and node keys must stay absent.
            return all(str(path.relative_to(home)) in {"config", "config/client.toml"}
                       for path in home.rglob("*"))

        # A later, deliberate option error proves the approved setup passes
        # admission, while still stopping before any store or listener opens.
        result = run(["start", "--pruning", "startup-test-invalid"], setup, root / "approved")
        if result.returncode == 0 or "unknown pruning strategy startup-test-invalid" not in result.stdout or SETUP_ERROR in result.stdout:
            raise AssertionError(f"approved setup did not pass startup admission:\n{result.stdout}")
        print("PASS approved setup: startup admission")

        commands = (["start"], ["in-place-testnet", "startup-test", "unused-operator"])
        for name, contents in malformed.items():
            path = root / (name + ".txt")
            if contents is not None:
                path.write_bytes(contents)
            for arguments in commands:
                home = root / (name + "-" + arguments[0])
                result = run(arguments, path, home)
                if result.returncode == 0 or SETUP_ERROR not in result.stdout:
                    raise AssertionError(f"{name} {arguments[0]} did not reject setup:\n{result.stdout}")
                if not server_untouched(home):
                    raise AssertionError(f"{name} {arguments[0]} initialized the server before rejecting setup")
                print(f"PASS {name}: {arguments[0]}")

        home = root / "missing-default"
        result = run(["start"], None, home)
        if result.returncode == 0 or SETUP_ERROR not in result.stdout or not server_untouched(home):
            raise AssertionError(f"missing default setup was not rejected before initialization:\n{result.stdout}")
        print("PASS missing default setup: start")

        # Use the actual release layout and daemon, including a symlink launched
        # from an unrelated directory. No environment override supplies the path.
        archive = root / "release"
        (archive / "bin").mkdir(parents=True)
        (archive / "config").mkdir()
        packaged_binary = archive / "bin" / "polystorechaind"
        shutil.copy2(binary, packaged_binary)
        packaged_setup = archive / "config" / "trusted_setup.txt"
        packaged_setup.write_bytes(approved)
        linked_binary = root / "linked-polystorechaind"
        linked_binary.symlink_to(packaged_binary)
        source_tree = root / "source-tree"
        (source_tree / "polystorechain").mkdir(parents=True)
        source_setup = source_tree / "polystorechain" / "trusted_setup.txt"
        source_setup.write_bytes(approved)
        for name, executable, cwd in (("archive-root", packaged_binary, archive),
                                      ("archive-symlink", linked_binary, root),
                                      ("source-tree", packaged_binary, source_tree)):
            result = run(["start", "--pruning", "startup-test-invalid"], None,
                         root / name, executable, cwd)
            if result.returncode == 0 or "unknown pruning strategy startup-test-invalid" not in result.stdout or SETUP_ERROR in result.stdout:
                raise AssertionError(f"{name} setup discovery failed:\n{result.stdout}")
            print(f"PASS {name}: default setup admission")
        for name, override in (("explicit-missing", root / "missing.txt"),
                               ("explicit-substituted", root / "substituted.txt")):
            home = root / name
            result = run(["start"], override, home, packaged_binary, archive)
            if result.returncode == 0 or SETUP_ERROR not in result.stdout or not server_untouched(home):
                raise AssertionError(f"{name} fell back to the bundled setup:\n{result.stdout}")
            print(f"PASS {name}: no bundled fallback")
        source_setup.write_bytes(substituted)
        home = root / "source-substituted"
        result = run(["start"], None, home, packaged_binary, source_tree)
        if result.returncode == 0 or SETUP_ERROR not in result.stdout or not server_untouched(home):
            raise AssertionError(f"invalid source setup fell back to the bundled setup:\n{result.stdout}")
        print("PASS source-substituted: no bundled fallback")
        packaged_setup.write_bytes(substituted)
        home = root / "archive-substituted"
        result = run(["start"], None, home, packaged_binary, archive)
        if result.returncode == 0 or SETUP_ERROR not in result.stdout or not server_untouched(home):
            raise AssertionError(f"substituted bundled setup was accepted:\n{result.stdout}")
        print("PASS archive-substituted: default setup rejected")

        for arguments in (["--help"], ["version"]):
            result = run(arguments, root / "missing.txt", root / "read-only")
            if result.returncode != 0 or "Initializing KZG" in result.stdout:
                raise AssertionError(f"read-only {arguments} required setup:\n{result.stdout}")
            print(f"PASS without setup: {' '.join(arguments)}")

        # A real local RPC reply demonstrates that query execution reaches the
        # network without requiring KZG, independently of connection timeouts.
        class RPCHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                reply = json.dumps({"jsonrpc": "2.0", "id": request["id"],
                                    "error": {"code": -32603, "message": "setup-startup-rpc-reached"}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args):
                pass

        with HTTPServer(("127.0.0.1", 0), RPCHandler) as rpc:
            thread = threading.Thread(target=rpc.serve_forever, daemon=True)
            thread.start()
            try:
                node = f"tcp://127.0.0.1:{rpc.server_port}"
                result = run(["query", "block", "--type", "height", "1", "--node", node], root / "missing.txt", root / "query")
            finally:
                rpc.shutdown()
                thread.join()
        if result.returncode == 0 or "setup-startup-rpc-reached" not in result.stdout or "Initializing KZG" in result.stdout:
            raise AssertionError(f"query did not reach RPC without setup:\n{result.stdout}")
        print("PASS without setup: query block reached RPC")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda value: Path(value).resolve(strict=True))
    parser.add_argument("setup", type=lambda value: Path(value).resolve(strict=True))
    args = parser.parse_args()
    check(args.binary, args.setup)
