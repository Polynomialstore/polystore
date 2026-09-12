"""Independent decision vectors for #259; NOT a channel implementation.

Pure arithmetic and counterexample models. No signatures, keeper, data delivery,
proof verification, or measured throughput are simulated by these checks.
"""

from dataclasses import dataclass, replace
import unittest


MAX_AMOUNT = (1 << 256) - 1


def amount(text):
    if (not isinstance(text, str) or not text or not text.isascii()
            or not text.isdecimal() or (len(text) > 1 and text[0] == "0")
            or len(text) > 78 or int(text) > MAX_AMOUNT):
        raise ValueError("noncanonical or overflowing amount")
    return int(text)


def checked(value):
    if not 0 <= value <= MAX_AMOUNT:
        raise ValueError("amount overflow")
    return value


def burn(variable, bps):
    if not 0 <= bps <= 10000:
        raise ValueError("invalid burn rate")
    checked(variable)
    # Arbitrary-precision intermediate, bounded result; not a uint256 multiply.
    return (variable * bps + 9999) // 10000


def economic_alternative(deposit, transfers, price, base, bps, *, cumulative):
    for value in (deposit, price, base, *transfers):
        checked(value)
    variable = [checked(blobs * price) for blobs in transfers]
    total = checked(sum(variable))
    base_burn = checked(base * (bool(transfers) if cumulative else len(transfers)))
    if checked(total + base_burn) > deposit:
        raise ValueError("underfunded")
    completion_burn = burn(total, bps) if cumulative else sum(burn(v, bps) for v in variable)
    return base_burn, completion_burn, total - completion_burn, deposit - total - base_burn


@dataclass(frozen=True)
class AdmissionModel:
    available: int
    nonce: int = 0
    liability: int = 0
    events: tuple = ()


def reserve_model(state, variables, *, base=3, denom="stake", entry_limit=64):
    """Atomic admission counterexample, not the protocol's admission API."""
    if denom != "stake" or not 1 <= len(variables) <= entry_limit:
        raise ValueError("invalid denomination or entry count")
    for value in variables:
        checked(value)
    required = checked(sum(variables) + checked(base * len(variables)))
    if required > state.available:
        raise ValueError("underfunded")
    return replace(state, available=state.available - required,
                   nonce=state.nonce + len(variables),
                   liability=checked(state.liability + sum(variables)),
                   events=state.events + (tuple(variables),))


def ack_model(previous, proposed, collateral):
    """(sequence, range commitment, cumulative value); assumes valid signatures."""
    if proposed == previous:
        return previous
    if (proposed[0] <= previous[0] or proposed[2] < previous[2]
            or not 0 <= proposed[2] <= collateral):
        raise ValueError("stale, conflicting, decreasing or uncovered ACK")
    return proposed


def withdrawable_model(collateral, paid, latest_ack, reserved):
    """Missing proof must not make acknowledged liability disappear."""
    if not 0 <= paid <= latest_ack <= reserved <= collateral:
        raise ValueError("inconsistent liability")
    return collateral - reserved


def fresh_checkpoint_model(committed_height, anchor_height, response_height):
    if not 0 < committed_height < anchor_height < response_height:
        raise ValueError("checkpoint was not committed before its future anchor")


class ChannelDecisionVectors(unittest.TestCase):
    def test_economic_alternatives_conserve_but_are_not_equivalent(self):
        old = economic_alternative(500, [101, 101], 1, 3, 1, cumulative=False)
        channel = economic_alternative(500, [101, 101], 1, 3, 1, cumulative=True)
        self.assertEqual(old, (6, 2, 200, 292))
        self.assertEqual(channel, (3, 1, 201, 295))
        self.assertEqual(sum(old), 500)
        self.assertEqual(sum(channel), 500)
        self.assertEqual(burn(101, 1), 1)
        self.assertEqual(burn(202, 1) - burn(101, 1), 0)
        self.assertEqual(burn(MAX_AMOUNT, 10000), MAX_AMOUNT)

    def test_underfunded_atomic_and_sequential_admission_differ(self):
        before = AdmissionModel(207)
        with self.assertRaisesRegex(ValueError, "underfunded"):
            reserve_model(before, [101, 101])
        self.assertEqual(before, AdmissionModel(207))  # No nonce/events/liability change.
        first = reserve_model(before, [101])
        self.assertEqual((first.available, first.nonce, first.liability), (103, 1, 101))
        with self.assertRaisesRegex(ValueError, "underfunded"):
            reserve_model(first, [101])
        self.assertEqual(reserve_model(AdmissionModel(208), [101, 101]).available, 0)

    def test_untrusted_amounts_and_limits(self):
        for text in ("", "-1", "+1", "01", "1.0", " 1", "１", str(1 << 256), None):
            with self.subTest(text=text), self.assertRaises(ValueError):
                amount(text)
        self.assertEqual(amount(str(MAX_AMOUNT)), MAX_AMOUNT)
        for variables, denom in (([], "stake"), ([0] * 65, "stake"), ([1], "other"), ([-1], "stake")):
            with self.assertRaises(ValueError):
                reserve_model(AdmissionModel(10000), variables, denom=denom)
        with self.assertRaisesRegex(ValueError, "overflow"):
            reserve_model(AdmissionModel(MAX_AMOUNT), [MAX_AMOUNT])
        with self.assertRaisesRegex(ValueError, "overflow"):
            economic_alternative(MAX_AMOUNT, [2], MAX_AMOUNT, 0, 1, cumulative=False)

    def test_exact_retry_conflict_stale_and_cumulative_bounds(self):
        old = (1, "range-A", 101)
        self.assertEqual(ack_model(old, old, 202), old)
        for proposed in ((0, "range-A", 101), (1, "range-B", 101),
                         (2, "range-B", 100), (2, "range-B", 203)):
            with self.assertRaises(ValueError):
                ack_model(old, proposed, 202)
        self.assertEqual(ack_model(old, (2, "range-B", 202), 202), (2, "range-B", 202))

    def test_stale_close_and_delayed_proof_do_not_free_acknowledged_value(self):
        collateral, latest_ack, reserved = 202, 202, 202
        # A close presenting the first ACK cannot replace the second ACK.
        with self.assertRaises(ValueError):
            ack_model((2, "range-B", 202), (1, "range-A", 101), collateral)
        self.assertEqual(withdrawable_model(collateral, 0, latest_ack, reserved), 0)
        self.assertEqual(withdrawable_model(collateral, 101, latest_ack, reserved), 0)
        # The unproved second liability remains reserved after partial payment.
        with self.assertRaises(ValueError):
            withdrawable_model(collateral, 101, latest_ack, 101)

    def test_freshness_requires_chain_observable_order(self):
        fresh_checkpoint_model(100, 101, 102)
        for committed, anchor, response in ((101, 101, 102), (102, 101, 103), (100, 101, 101)):
            with self.assertRaises(ValueError):
                fresh_checkpoint_model(committed, anchor, response)
        # No off-chain signature timestamp is accepted as an input or substitute.


if __name__ == "__main__":
    unittest.main()
