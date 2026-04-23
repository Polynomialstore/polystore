import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

try:
    from .policing_sim import (
        PolicySimulator,
        SimConfig,
        evaluate_assertions,
        load_scenario_spec,
        run_one,
        write_output_dir,
    )
    from .report import generate_policy_delta, generate_run_report
except ImportError:  # Allows `python3 -m unittest discover -s tools/policy_sim`.
    from policing_sim import (
        PolicySimulator,
        SimConfig,
        evaluate_assertions,
        load_scenario_spec,
        run_one,
        write_output_dir,
    )
    from report import generate_policy_delta, generate_run_report


class PolicySimulatorTests(unittest.TestCase):
    def run_scenario(self, scenario: str, **overrides):
        config = SimConfig(scenario=scenario, **overrides)
        result = PolicySimulator(config).run()
        evaluate_assertions(result)
        return result

    def assert_assertions_pass(self, result):
        failed = [item for item in result.assertions if not item.passed]
        self.assertEqual([], failed)

    def test_ideal_scenario_has_no_repairs_or_failures(self):
        result = self.run_scenario("ideal", providers=48, deals=24, users=80, epochs=8)

        self.assert_assertions_pass(result)
        self.assertEqual(1.0, result.totals["success_rate"])
        self.assertEqual(0, result.totals["repairs_started"])
        self.assertEqual(0, result.totals["quota_misses"])
        self.assertEqual(0, result.totals["invalid_proofs"])

    def test_outage_triggers_repair_without_availability_loss(self):
        result = self.run_scenario("single-outage", providers=48, deals=24, users=80, epochs=10)

        self.assert_assertions_pass(result)
        self.assertGreaterEqual(result.totals["repairs_started"], 1)
        self.assertGreaterEqual(result.totals["repairs_completed"], 1)
        self.assertEqual(0, result.totals["unavailable_reads"])

    def test_malicious_corrupt_provider_gets_repaired_and_not_paid_for_corrupt_bytes(self):
        result = self.run_scenario("malicious-corrupt", providers=48, deals=24, users=80, epochs=10)

        self.assert_assertions_pass(result)
        self.assertGreaterEqual(result.totals["invalid_proofs"], 1)
        self.assertGreaterEqual(result.totals["repairs_started"], 1)
        self.assertEqual(0, result.totals["paid_corrupt_bytes"])

    def test_custom_fault_injection(self):
        config = SimConfig(scenario="ideal", providers=24, deals=8, users=40, epochs=6)
        result = PolicySimulator(
            config,
            extra_faults=["offline:sp-000:2-3", "withhold:sp-001:1.0"],
        ).run()

        self.assertGreaterEqual(result.totals["offline_responses"], 1)
        self.assertGreaterEqual(result.totals["withheld_responses"], 1)
        self.assertGreaterEqual(result.totals["repairs_started"], 1)

    def test_custom_faults_do_not_reuse_builtin_ideal_assertions(self):
        config = SimConfig(scenario="ideal", providers=24, deals=8, users=40, epochs=6)
        result = PolicySimulator(config, extra_faults=["offline:sp-000:2-3"]).run()
        assertions = evaluate_assertions(result, min_success_rate=0.99)

        self.assertEqual(["min_success_rate"], [item.name for item in assertions])

    def test_fixture_run_emits_output_contract(self):
        fixture = Path(__file__).with_name("scenarios") / "ideal.yaml"
        spec = load_scenario_spec(fixture)
        config = SimConfig(**spec.config)
        result = run_one(config, spec.faults, spec.assertions, None)

        with TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            write_output_dir(out_dir, result)
            expected = {
                "summary.json",
                "assertions.json",
                "epochs.csv",
                "providers.csv",
                "slots.csv",
                "evidence.csv",
                "repairs.csv",
                "economy.csv",
            }
            self.assertEqual(expected, {path.name for path in out_dir.iterdir()})

    def test_report_generation_consumes_output_contract(self):
        fixture = Path(__file__).with_name("scenarios") / "single_outage.yaml"
        spec = load_scenario_spec(fixture)
        config = SimConfig(**spec.config)
        result = run_one(config, spec.faults, spec.assertions, None)

        with TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            report_dir = Path(tmp) / "report"
            write_output_dir(run_dir, result)
            generate_run_report(run_dir, report_dir)

            self.assertTrue((report_dir / "report.md").exists())
            self.assertTrue((report_dir / "risk_register.md").exists())
            self.assertTrue((report_dir / "graduation.md").exists())
            self.assertTrue((report_dir / "graphs" / "retrieval_success_rate.svg").exists())

    def test_policy_delta_report_compares_two_runs(self):
        ideal = load_scenario_spec(Path(__file__).with_name("scenarios") / "ideal.yaml")
        outage = load_scenario_spec(Path(__file__).with_name("scenarios") / "single_outage.yaml")
        ideal_result = run_one(SimConfig(**ideal.config), ideal.faults, ideal.assertions, None)
        outage_result = run_one(SimConfig(**outage.config), outage.faults, outage.assertions, None)

        with TemporaryDirectory() as tmp:
            base_dir = Path(tmp) / "base"
            candidate_dir = Path(tmp) / "candidate"
            report_dir = Path(tmp) / "delta"
            write_output_dir(base_dir, ideal_result)
            write_output_dir(candidate_dir, outage_result)
            generate_policy_delta(base_dir, candidate_dir, report_dir)

            text = (report_dir / "policy_delta.md").read_text(encoding="utf-8")
            self.assertIn("success_rate", text)
            self.assertIn("repairs_started", text)


if __name__ == "__main__":
    unittest.main()
