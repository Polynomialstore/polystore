"""Independent committed issuance accounting; no node processes."""
import copy
from types import SimpleNamespace
import unittest

import retrieval_four_validator_workload as workload
from test_retrieval_four_validator_workload import ADDRESSES, settlement_fixture


def event(kind, **attributes):
    return dict(type=kind, attributes=[dict(key=k, value=v) for k, v in attributes.items()])


def block(amount=7):
    return dict(height='12', txs_results=None, finalize_block_events=[
        event('coinbase', minter=ADDRESSES[0], amount=f'{amount}stake'),
        event('mint', amount=str(amount))])


class MintSettlementTest(unittest.TestCase):
    def test_strict_mint_and_coinbase_reconciliation(self):
        self.assertEqual(workload.block_issuance(block(), 12, ADDRESSES[0])['issued_stake'], 7)
        zero = block(0)
        zero['finalize_block_events'].pop(0)
        self.assertEqual(workload.block_issuance(zero, 12, ADDRESSES[0])['issued_stake'], 0)
        failed = block()
        failed['txs_results'] = [dict(code=4, events=[event('coinbase', minter=ADDRESSES[1], amount='999stake')])]
        self.assertEqual(workload.block_issuance(failed, 12, ADDRESSES[0])['issued_stake'], 7)
        mutations = [lambda d: d.pop('txs_results'), lambda d: d.pop('finalize_block_events'),
            lambda d: d.update(height='13'), lambda d: d['finalize_block_events'].pop(),
            lambda d: d['finalize_block_events'].pop(0),
            lambda d: d['finalize_block_events'].append(event('mint', amount='7')),
            lambda d: d['finalize_block_events'][0]['attributes'].append(dict(key='amount', value='7stake')),
            lambda d: d['finalize_block_events'][0]['attributes'][0].update(value=ADDRESSES[1]),
            lambda d: d['finalize_block_events'][0]['attributes'][1].update(value='7aatom'),
            lambda d: d['finalize_block_events'][1]['attributes'][0].update(value='-7'),
            lambda d: d['finalize_block_events'][1]['attributes'][0].update(value='8'),
            lambda d: d.update(txs_results=[dict(code=0, events=[event('coinbase', minter=ADDRESSES[1], amount='1stake')])])]
        for mutate in mutations:
            row = block()
            mutate(row)
            with self.assertRaises((ValueError, KeyError)):
                workload.block_issuance(row, 12, ADDRESSES[0])

    def test_four_validator_interval_disagreement_and_cache(self):
        calls = []
        fault = False
        def query(node, route, height=None):
            calls.append((node['node_id'], route))
            if 'module_accounts' in route:
                return dict(account=dict(name='mint', base_account=dict(address=ADDRESSES[0])))
            return block(8 if fault and node['node_id'] == '3' else 7)
        life = SimpleNamespace(nodes=[dict(node_id=str(i)) for i in range(4)], query=query, doc={})
        before, after = dict(bank=dict(height=11)), dict(bank=dict(height=12))
        self.assertEqual(workload.collect_issuance(life, before, after), 7)
        count = len(calls)
        self.assertEqual(workload.collect_issuance(life, before, after), 7)
        self.assertEqual(len(calls), count)
        life.doc = {}
        fault = True
        with self.assertRaisesRegex(ValueError, 'validators disagree'):
            workload.collect_issuance(life, before, after)

    def test_independent_issuance_adjusts_only_supply(self):
        before, after, operations, results, transactions, signers = settlement_fixture()
        after['bank']['supply']['stake'] = str(int(after['bank']['supply']['stake']) + 7)
        workload.verify_settlement(before, after, operations, results, transactions, signers, issued_stake=7)
        with self.assertRaisesRegex(ValueError, 'conservation'):
            workload.verify_settlement(before, after, operations, results, transactions, signers, issued_stake=6)
        unchanged = copy.deepcopy(before)
        unchanged['bank']['supply']['stake'] = str(int(before['bank']['supply']['stake']) + 7)
        workload.assert_unchanged_retrieval(before, unchanged, issued_stake=7)
        with self.assertRaises(ValueError):
            workload.assert_unchanged_retrieval(before, unchanged, issued_stake=6)


if __name__ == '__main__':
    unittest.main()
