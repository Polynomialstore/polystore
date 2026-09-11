"""Offline adversarial settlement orchestration; no processes or native load."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import retrieval_four_validator_workload as workload
from test_retrieval_four_validator_workload import fixture_state, settlement_fixture


class AdversarialSettlementTest(unittest.TestCase):
    def test_rejections_and_duplicates_preserve_stake_and_every_retrieval_field(self):
        _, before, _, _, _, _ = settlement_fixture()
        after = copy.deepcopy(before)
        after['bank']['height'] = 99
        after['bank']['balances']['owner0:aatom'] = '1'
        workload.assert_unchanged_retrieval(before, after)
        mutations = [lambda d: d['retrieval']['deals']['0'].update(escrow_balance='999'),
                     lambda d: d['retrieval']['activities']['0'].update(bytes_served_total='999'),
                     lambda d: d['retrieval'].update(module_stake='999'),
                     lambda d: d['bank']['supply'].update(stake='999'),
                     lambda d: d['bank']['balances'].update({'provider0:stake': '999'}),
                     lambda d: next(iter(d['retrieval']['sessions'].values())).update(locked_fee='999')]
        for mutate in mutations:
            changed = copy.deepcopy(after)
            mutate(changed)
            with self.assertRaises(ValueError):
                workload.assert_unchanged_retrieval(before, changed)

    def test_four_node_result_identity_and_gas_are_mandatory(self):
        raw = b'signed transaction'
        encoded = base64.b64encode(raw).decode()
        txhash = hashlib.sha256(raw).hexdigest().upper()
        result = dict(txhash=txhash, height=12, code=4, gas_wanted=20000000, gas_used=123,
                      outcome='committed_failure')
        for fault in (None, 'gas', 'hash', 'height', 'body'):
            def query(node, route):
                bad = node['node_id'] == '3'
                if route == '/block?height=12':
                    block_tx = (base64.b64encode(b'other').decode() if bad and fault == 'hash' else
                                'not-base64!' if bad and fault == 'body' else encoded)
                    return {'block_id': {'hash': '11' * 32}, 'block': {
                        'header': {'height': '13' if bad and fault == 'height' else '12',
                                   'chain_id': 'polystore_291-1', 'app_hash': '22' * 32,
                                   'time': '2026-01-01T00:00:00Z'},
                        'data': {'txs': [block_tx]}}}
                if route == '/block_results?height=12':
                    return {'height': '12', 'txs_results': [dict(
                        code=4, gas_wanted='20000000',
                        gas_used='124' if bad and fault == 'gas' else '123')]}
                self.fail('unexpected query ' + route)
            life = SimpleNamespace(chain='polystore_291-1',
                nodes=[dict(node_id=str(i)) for i in range(4)], query=query,
                wait_height=Mock(return_value=13))
            if fault:
                with self.assertRaises(ValueError): workload.verify_transaction_nodes(life, result)
            else:
                self.assertEqual(len(workload.verify_transaction_nodes(life, result)), 4)

    def test_five_rejections_then_four_idempotent_retries_use_real_prepared_payloads(self):
        life, _, deals, operations = fixture_state()
        life.signers['control'] = life.signers['owner0']
        life.doc, life.save, life.wait_height = {}, Mock(), Mock(return_value=20)
        _, snapshot, _, _, _, _ = settlement_fixture()
        with tempfile.TemporaryDirectory() as home:
            life.home = Path(home)
            prepared = []
            for i, operation in enumerate(operations):
                sid = bytes([i+1] * 32).hex()
                payload = dict(session_id=base64.b64encode(bytes.fromhex(sid)).decode(), proofs=[dict(
                    z_value=base64.b64encode(bytes([2]) * 32).decode(),
                    y_value=base64.b64encode(bytes([3]) * 32).decode())] * operation['proof_expectation']['session']['blob_count'])
                path = life.home / (sid + '.json')
                path.write_text(json.dumps(payload))
                prepared.append(dict(operation, prepared=dict(session_id=sid, proof_path=str(path))))
            submitted = []
            def submit(job):
                submitted.append(job)
                self.assertEqual(job['submit'][job['submit'].index('--gas')+1], '20000000')
                label = job['kind']
                reason = ('authorized proof provider' if 'wrong-signer' in label else
                          'exact session challenge tuple and z' if 'wrong-z' in label else
                          'invalid retrieval proof')
                return dict(outcome='committed_success' if label.startswith('duplicate') else 'committed_failure',
                    error=reason, height=19, txhash='AB'*32, code=0 if label.startswith('duplicate') else 4)
            with patch.object(workload.artifact, 'scheduled_transaction', side_effect=submit), \
                 patch.object(workload, 'retrieval_snapshot', return_value=snapshot), \
                 patch.object(workload, 'collect_issuance', return_value=0), \
                 patch.object(workload, 'verify_transaction_nodes', return_value=[{}]*4):
                workload.run_adversarial_phase(life, deals, prepared)
                self.assertEqual(len(submitted), 5)
                multi = next(job for job in submitted if job['kind'] == 'later-native-failure')
                payload = json.loads(Path(multi['submit'][4]).read_text())
                self.assertEqual(len(payload['sessions']), 2)
                self.assertNotEqual(payload['sessions'][0]['session_id'], payload['sessions'][1]['session_id'])
                self.assertEqual(payload['sessions'][0]['proofs'][0]['y_value'], base64.b64encode(bytes([3])*32).decode())
                self.assertEqual(payload['sessions'][1]['proofs'][0]['z_value'], base64.b64encode(bytes([2])*32).decode())
                self.assertNotEqual(payload['sessions'][1]['proofs'][0]['y_value'], base64.b64encode(bytes([3])*32).decode())
                workload.run_adversarial_phase(life, deals, prepared, completed=True)
                self.assertEqual(len(submitted), 9)
                self.assertTrue(all(row['state_unchanged'] for phase in life.doc['adversarial_phases'].values() for row in phase['transactions']))
                original_home = life.home
                for fault in ('unknown', 'wrong-rejection-reason', 'unexpected-success'):
                    life.home = original_home / fault
                    life.home.mkdir()
                    wrong = dict(outcome='unknown' if fault == 'unknown' else
                                 'committed_success' if fault == 'unexpected-success' else 'committed_failure',
                                 error='out of gas', height=19)
                    with patch.object(workload.artifact, 'scheduled_transaction', return_value=wrong) as attempt:
                        with self.assertRaisesRegex(ValueError, 'unexpected adversarial outcome'):
                            workload.run_adversarial_phase(life, deals, prepared)
                        self.assertEqual(attempt.call_count, 1)
                        self.assertNotIn('state_unchanged', life.doc['adversarial_phases']['before-proof']['transactions'][0])



if __name__ == '__main__':
    unittest.main()
