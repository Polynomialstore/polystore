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

    def test_heterogeneous_scale_controls_surface_saturation_and_repair_backoff(self):
        config = SimConfig(
            scenario="large-scale-regional-stress",
            seed=29,
            providers=60,
            users=240,
            deals=40,
            epochs=8,
            retrievals_per_user_per_epoch=2,
            provider_regions=("na", "eu", "apac"),
            regional_outages=({"region": "eu", "epochs": "3-5"},),
            provider_capacity_min=8,
            provider_capacity_max=12,
            provider_bandwidth_capacity_min=5,
            provider_bandwidth_capacity_max=12,
            provider_online_probability_min=0.98,
            provider_online_probability_max=1.0,
            provider_repair_probability_min=0.5,
            provider_repair_probability_max=0.9,
            max_repairs_started_per_epoch=3,
            repair_epochs=2,
            dynamic_pricing=True,
            retrieval_target_per_epoch=300,
        )
        result = PolicySimulator(config).run()

        self.assertGreater(result.totals["saturated_responses"], 0)
        self.assertGreater(result.totals["repair_backoffs"], 0)
        self.assertEqual(0, result.totals["providers_over_capacity"])
        self.assertLess(result.totals["final_storage_utilization_bps"], 10_000)
        self.assertIn("capacity_slots", result.providers[0])
        self.assertIn("bandwidth_capacity_per_epoch", result.providers[0])

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
            self.assertTrue((report_dir / "signals.json").exists())
            self.assertTrue((report_dir / "graphs" / "retrieval_success_rate.svg").exists())
            self.assertTrue((report_dir / "graphs" / "price_trajectory.svg").exists())
            self.assertTrue((report_dir / "graphs" / "saturation_and_repair.svg").exists())
            self.assertTrue((report_dir / "graphs" / "capacity_utilization.svg").exists())
            self.assertTrue((report_dir / "graphs" / "repair_backlog.svg").exists())
            graph_text = (report_dir / "graphs" / "retrieval_success_rate.svg").read_text(encoding="utf-8")
            self.assertNotIn("Scale: x=epoch", graph_text)
            self.assertIn('y1="52"', graph_text)
            self.assertIn(">Epoch<", graph_text)
            self.assertIn("Retrieval Success Rate", graph_text)
            report_text = (report_dir / "report.md").read_text(encoding="utf-8")
            self.assertIn("## Executive Summary", report_text)
            self.assertIn("## What Happened", report_text)
            self.assertIn("## Diagnostic Signals", report_text)
            self.assertIn("### Regional Signals", report_text)
            self.assertIn("### Top Bottleneck Providers", report_text)
            self.assertIn("## Enforcement Interpretation", report_text)
            self.assertIn("## Economic Interpretation", report_text)
            self.assertIn("## Evidence Ledger Excerpt", report_text)
            self.assertIn("![Retrieval Success Rate](graphs/retrieval_success_rate.svg)", report_text)
            self.assertIn("![Slot State Transitions](graphs/slot_states.svg)", report_text)
            self.assertIn("![Provider P&L](graphs/provider_pnl.svg)", report_text)
            self.assertIn("![Burn / Mint Ratio](graphs/burn_mint_ratio.svg)", report_text)
            self.assertIn("![Price Trajectory](graphs/price_trajectory.svg)", report_text)
            self.assertIn("![Saturation And Repair Pressure](graphs/saturation_and_repair.svg)", report_text)
            self.assertIn("![Capacity Utilization](graphs/capacity_utilization.svg)", report_text)
            self.assertIn("![Repair Backlog](graphs/repair_backlog.svg)", report_text)
            signal_text = (report_dir / "signals.json").read_text(encoding="utf-8")
            self.assertIn("availability", signal_text)
            self.assertIn("top_bottleneck_providers", signal_text)
            risk_text = (report_dir / "risk_register.md").read_text(encoding="utf-8")
            self.assertIn("## Material Risks", risk_text)
            graduation_text = (report_dir / "graduation.md").read_text(encoding="utf-8")
            self.assertIn("## Readiness Checklist", graduation_text)

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
            self.assertIn("## High-Signal Changes", text)
            self.assertIn("## Human Review Questions", text)


if __name__ == "__main__":
    unittest.main()
