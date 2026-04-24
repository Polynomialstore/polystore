import json
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
    from .report import generate_policy_delta, generate_run_report, generate_sweep_report, main as report_main
    from .generate_report_corpus import write_graduation_map
    from .run_sweeps import load_sweep_spec, run_sweep_spec
except ImportError:  # Allows `python3 -m unittest discover -s tools/policy_sim`.
    from policing_sim import (
        PolicySimulator,
        SimConfig,
        evaluate_assertions,
        load_scenario_spec,
        run_one,
        write_output_dir,
    )
    from report import generate_policy_delta, generate_run_report, generate_sweep_report, main as report_main
    from generate_report_corpus import write_graduation_map
    from run_sweeps import load_sweep_spec, run_sweep_spec


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
        self.assertEqual(0, result.totals["data_loss_events"])
        self.assertLess(result.totals["final_storage_utilization_bps"], 10_000)
        self.assertIn("capacity_slots", result.providers[0])
        self.assertIn("bandwidth_capacity_per_epoch", result.providers[0])

    def test_jail_window_is_exclusive(self):
        simulator = PolicySimulator(
            SimConfig(
                scenario="ideal",
                providers=12,
                deals=1,
                users=1,
                epochs=1,
                retrievals_per_user_per_epoch=0,
            )
        )
        provider = simulator.providers["sp-000"]
        provider.jailed_until_epoch = 8

        self.assertTrue(simulator._is_jailed(provider, 7))
        self.assertFalse(simulator._is_jailed(provider, 8))

    def test_economy_provider_pnl_is_per_epoch_not_cumulative(self):
        result = self.run_scenario("ideal", providers=48, deals=24, users=80, epochs=4)
        epoch_pnls = [row["provider_pnl"] for row in result.economy]

        self.assertEqual(4, len(epoch_pnls))
        self.assertAlmostEqual(epoch_pnls[0], epoch_pnls[1])
        self.assertAlmostEqual(result.totals["provider_pnl"], sum(epoch_pnls))

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

    def test_scenario_fixture_parse_error_explains_strict_json_contract(self):
        with TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "not-json.yaml"
            fixture.write_text("name: yaml-only\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "strict JSON"):
                load_scenario_spec(fixture)

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

    def test_report_cli_default_keeps_raw_run_directory_clean(self):
        fixture = Path(__file__).with_name("scenarios") / "single_outage.yaml"
        spec = load_scenario_spec(fixture)
        result = run_one(SimConfig(**spec.config), spec.faults, spec.assertions, None)

        with TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            write_output_dir(run_dir, result)
            report_main(["--run-dir", str(run_dir)])

            self.assertTrue((run_dir / "report" / "report.md").exists())
            self.assertFalse((run_dir / "report.md").exists())

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

    def test_sweep_report_summarizes_run_directories(self):
        ideal = load_scenario_spec(Path(__file__).with_name("scenarios") / "ideal.yaml")
        outage = load_scenario_spec(Path(__file__).with_name("scenarios") / "single_outage.yaml")
        ideal_result = run_one(SimConfig(**ideal.config), ideal.faults, ideal.assertions, None)
        outage_result = run_one(SimConfig(**outage.config), outage.faults, outage.assertions, None)

        with TemporaryDirectory() as tmp:
            sweep_dir = Path(tmp) / "sweep"
            report_dir = Path(tmp) / "report"
            write_output_dir(sweep_dir / "ideal", ideal_result)
            write_output_dir(sweep_dir / "single-outage", outage_result)
            generate_sweep_report(sweep_dir, report_dir)

            self.assertTrue((report_dir / "sweep_summary.md").exists())
            self.assertTrue((report_dir / "sweep_summary.json").exists())
            text = (report_dir / "sweep_summary.md").read_text(encoding="utf-8")
            self.assertIn("Policy Simulation", text)
            self.assertIn("## Run Matrix", text)
            self.assertIn("## Key Metric Ranges", text)
            self.assertIn("## High-Risk Runs", text)
            self.assertIn("single-outage", text)
            self.assertIn("success_rate", text)
            payload = (report_dir / "sweep_summary.json").read_text(encoding="utf-8")
            self.assertIn('"metric_ranges"', payload)
            self.assertIn('"high_risk_runs"', payload)
            rows = json.loads(payload)["runs"]
            self.assertIn("sweep-artifacts/sweep/ideal", {row["run_dir"] for row in rows})

    def test_graduation_map_links_scenarios_to_implementation_targets(self):
        rows = [
            {
                "scenario": "ideal",
                "verdict": "PASS",
                "success_rate": 1.0,
                "unavailable_reads": 0,
                "data_loss_events": 0,
                "repairs_started": 0,
                "repairs_completed": 0,
                "repair_backoffs": 0,
                "providers_negative_pnl": 0,
                "saturated_responses": 0,
                "assertions": [],
            },
            {
                "scenario": "corrupt-provider",
                "verdict": "PASS",
                "success_rate": 1.0,
                "unavailable_reads": 0,
                "data_loss_events": 0,
                "repairs_started": 1,
                "repairs_completed": 1,
                "repair_backoffs": 0,
                "providers_negative_pnl": 0,
                "saturated_responses": 0,
                "assertions": [],
            },
        ]
        with TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            write_graduation_map(out_dir, rows)

            self.assertTrue((out_dir / "graduation_map.md").exists())
            self.assertTrue((out_dir / "graduation_map.json").exists())
            text = (out_dir / "graduation_map.md").read_text(encoding="utf-8")
            self.assertIn("## Scenario-to-Implementation Map", text)
            self.assertIn("hard-fault keeper path", text)
            self.assertIn("Provider returns corrupt bytes or invalid proof", text)
            payload = (out_dir / "graduation_map.json").read_text(encoding="utf-8")
            self.assertIn('"implementation planning"', payload)

    def test_sweep_spec_runner_expands_matrix_and_reports(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            scenario = root / "base.yaml"
            scenario.write_text(
                """
{
  "name": "ideal",
  "config": {
    "scenario": "ideal",
    "seed": 7,
    "providers": 24,
    "users": 8,
    "deals": 4,
    "epochs": 3
  },
  "assertions": {
    "min_success_rate": 1.0,
    "max_repairs_started": 0
  }
}
""".strip()
                + "\n",
                encoding="utf-8",
            )
            sweep = root / "sweep.yaml"
            sweep.write_text(
                """
{
  "name": "test-sweep",
  "description": "Small unit-test sweep.",
  "base_scenario": "base.yaml",
  "matrix": {
    "seed": [7, 8]
  }
}
""".strip()
                + "\n",
                encoding="utf-8",
            )

            spec = load_sweep_spec(sweep)
            self.assertEqual(2, len(spec.cases))
            manifest = run_sweep_spec(sweep, root / "runs", root / "reports")

            self.assertEqual(2, manifest["case_count"])
            self.assertEqual("sweep-artifacts/test-sweep", manifest["raw_run_dir"])
            self.assertTrue((root / "reports" / "test-sweep" / "sweep_summary.md").exists())
            self.assertTrue((root / "reports" / "test-sweep" / "sweep_summary.json").exists())
            self.assertTrue((root / "reports" / "test-sweep" / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
