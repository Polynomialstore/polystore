import unittest

try:
    from .policing_sim import PolicySimulator, SimConfig, evaluate_assertions
except ImportError:  # Allows `python3 -m unittest discover -s tools/policy_sim`.
    from policing_sim import PolicySimulator, SimConfig, evaluate_assertions


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


if __name__ == "__main__":
    unittest.main()
