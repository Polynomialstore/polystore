"""Owned subprocess cleanup regressions; no nodes or listening sockets."""
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import retrieval_bench_artifact as artifact


class OwnedProcessGroupsTest(unittest.TestCase):
    def test_bounded_command_preserves_timeout_for_darwin_zombie_group(self):
        # The mocked EPERM affects only the final signal after this child exits.
        with patch.object(artifact.os, "killpg", side_effect=PermissionError("zombie")), \
             patch.object(artifact.platform, "system", return_value="Darwin"), \
             patch.object(artifact.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="Z\n")), \
             patch.object(artifact, "monotonic_ns", side_effect=[0, 2_000_000_000]):
            with self.assertRaises(subprocess.TimeoutExpired):
                artifact.run_bounded_command([sys.executable, "-c", "pass"], 1_000_000_000)

    def test_permission_failure_requires_positive_all_zombie_evidence(self):
        for system, result in (("Linux", SimpleNamespace(returncode=0, stdout="Z\n")),
                               ("Darwin", SimpleNamespace(returncode=0, stdout="Z\nS\n")),
                               ("Darwin", SimpleNamespace(returncode=0, stdout="")),
                               ("Darwin", SimpleNamespace(returncode=1, stdout="Z\n")),
                               ("Darwin", subprocess.TimeoutExpired("ps", 2))):
            with self.subTest(system=system, result=result), \
                 patch.object(artifact.os, "killpg", side_effect=PermissionError("denied")), \
                 patch.object(artifact.platform, "system", return_value=system), \
                 patch.object(artifact.subprocess, "run", **({"side_effect": result} if isinstance(result, Exception) else {"return_value": result})):
                with self.assertRaises(PermissionError):
                    artifact.signal_owned_process_group(123, signal.SIGKILL)

    @unittest.skipUnless(platform.system() == "Darwin", "Darwin zombie-only killpg behavior")
    def test_actual_darwin_zombie_only_group(self):
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            os.killpg(process.pid, signal.SIGTERM)
            for _ in range(100):
                state = subprocess.run(["ps", "-o", "stat=", "-g", str(process.pid)], capture_output=True, text=True, timeout=2)
                if state.stdout.strip().startswith("Z"):
                    break
                time.sleep(0.01)
            self.assertTrue(state.stdout.strip().startswith("Z"))
            self.assertIsNone(process.returncode)  # Still owned and unreaped.
            artifact.signal_owned_process_group(process.pid, signal.SIGKILL)
            self.assertEqual(process.wait(timeout=2), -signal.SIGTERM)
        finally:
            if process.returncode is None:
                process.wait(timeout=2)

    def test_cleanup_stops_live_descendant_after_leader_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "child"
            body = "import pathlib,signal,time,sys; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); time.sleep(30)"
            process = subprocess.Popen([sys.executable, "-c", "import subprocess,sys; subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]])", body, str(ready)], start_new_session=True)
            try:
                for _ in range(200):
                    if ready.exists():
                        break
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                child = int(ready.read_text())
                artifact.stop_owned_process_groups([process])
                for _ in range(100):
                    state = subprocess.run(["ps", "-o", "stat=", "-p", str(child)], capture_output=True, text=True, timeout=2).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(0.01)
                self.assertTrue(not state or state.startswith("Z"), state)
            finally:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                    process.wait(timeout=2)

    def test_command_cleanup_permission_failure_is_not_launch_failure(self):
        processes, launch = [], subprocess.Popen
        def tracked_launch(*args, **kwargs):
            process = launch(*args, **kwargs)
            processes.append(process)
            return process
        try:
            with patch.object(artifact, "signal_owned_process_group", side_effect=PermissionError("denied")), \
                 patch.object(artifact.subprocess, "Popen", side_effect=tracked_launch), \
                 patch.object(artifact, "monotonic_ns", side_effect=[0, 2_000_000_000]):
                with self.assertRaisesRegex(ValueError, "CLI cleanup failed: denied"):
                    artifact.run_bounded_command([sys.executable, "-c", "pass"], 1_000_000_000)
                self.assertIsNone(processes[0].returncode)
        finally:
            # This simulated denied group is a known short-lived child. Keep
            # test ownership until it exits instead of leaving Popen to reap it.
            for process in processes:
                process.wait(timeout=2)

    def test_post_reap_decode_failure_does_not_signal_reused_pid(self):
        with patch.object(artifact, "signal_owned_process_group") as send:
            with self.assertRaises(UnicodeDecodeError):
                artifact.run_bounded_command([sys.executable, "-c", "import os; os.write(1, bytes([255]))"],
                                             artifact.monotonic_ns() + 2_000_000_000)
            send.assert_not_called()

    def test_healthy_cleanup_failure_is_saved_and_still_stops_validators(self):
        from unittest.mock import Mock
        import retrieval_four_validator_workload as workload
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "polystore_cli/src").mkdir(parents=True)
            (root / "polystore_cli/src/main.rs").touch()
            life = SimpleNamespace(home=root / "run", doc={}, stop=Mock(), reservations=[])
            snapshots = []
            life.save = lambda: snapshots.append(dict(life.doc))
            def failed_cleanup(processes):
                # Isolate the finalizer from the audit body: success may already
                # be recorded when this cleanup error occurs.
                life.doc["status"] = "healthy_provider_audit_diagnostic_passed"
                raise PermissionError("live group denied")
            with patch.object(workload, "require_retrieval_cli", side_effect=ValueError("stop before node setup")), \
                 patch.object(artifact, "stop_owned_process_groups", side_effect=failed_cleanup):
                with self.assertRaises(PermissionError):
                    workload.run_healthy(life, sys.executable, sys.executable, root)
            life.stop.assert_called_once()
            self.assertEqual(snapshots[-1]["status"], "failed")
            self.assertEqual(snapshots[-1]["cleanup_error"], "live group denied")

    def test_cleanup_attempts_every_group_without_reaping_failed_group(self):
        from unittest.mock import Mock
        processes = [Mock(pid=123), Mock(pid=456)]
        def send(pid, sig):
            if pid == 123:
                raise PermissionError("live group denied")
        with patch.object(artifact, "signal_owned_process_group", side_effect=send) as send_mock, patch.object(artifact.time, "sleep"):
            with self.assertRaises(PermissionError):
                artifact.stop_owned_process_groups(processes)
        self.assertEqual(send_mock.call_count, 4)
        processes[0].wait.assert_not_called()
        processes[1].wait.assert_called_once_with(timeout=5)


if __name__ == "__main__":
    unittest.main()
