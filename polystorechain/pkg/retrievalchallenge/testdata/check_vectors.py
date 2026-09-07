"""Independent oracle: Python stdlib, transcribed from the frozen wire schema."""
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).parent
GOLDEN = json.loads((BASE / 'challenge-golden.json').read_text())
SCHEMA = GOLDEN['schema']
FR = int('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001', 16)
SEED = bytes.fromhex(SCHEMA['seed_hex'])

def u(value, width):
    return value.to_bytes(width, 'big')

def lp(value):
    value = value.encode()
    return u(len(value), 4) + value

def encode(values):
    result = b''
    for name, kind, default in SCHEMA['fields']:
        value = values.get(name, default)
        if kind == 'LP':
            result += lp(value)
        elif kind.startswith('hex'):
            result += bytes.fromhex(value)
        else:
            result += u(value, int(kind[1:]) // 8)
    return result

def challenge(ctx, ordinal, mdu, leaf):
    prefix = lp('polystore/blob-challenge/v2') + ctx + SEED + u(ordinal, 8) + u(mdu, 8) + u(leaf, 4)
    for counter in range(256):
        digest = hashlib.sha256(prefix + u(counter, 4)).digest()
        z = int.from_bytes(digest, 'big')
        if 0 < z < FR and pow(z, 4096, FR) != 1:
            return {'ordinal': ordinal, 'mdu_index': mdu, 'leaf_index': leaf, 'z': digest.hex(), 'scalar_counter': counter}
    raise ValueError('exhausted')

vectors = {'schema': SCHEMA, 'vectors': {}}
for name, override in [('session', {}), ('audit', SCHEMA['audit_override'])]:
    values = {field: default for field, kind, default in SCHEMA['fields']}
    values.update(override)
    for field, kind, _ in SCHEMA['fields']:
        if kind == 'u64':
            value = values[field]
            assert isinstance(value, str) and value.isascii() and value.isdecimal(), 'u64 fixture inputs must be decimal strings'
            values[field] = int(value)
    wire = encode(values)
    ctx = hashlib.sha256(wire).digest()
    rows = 64 // values['k']
    population = values['user_mdus'] * rows
    samples = []
    if name == 'session':
        for i in range(values['blob_count']):
            leaf = values['start_leaf'] + i
            sample = challenge(ctx, i, values['start_mdu'], leaf)
            sample['population_index'] = (values['start_mdu'] - values['metadata_mdus']) * rows + leaf - values['slot'] * rows
            samples.append(sample)
    else:
        # This independent implementation uses a full list rather than the Go
        # sparse map; both implement sampling without replacement by swap-delete.
        available = list(range(population))
        for i in range(values['sample_count']):
            n = len(available)
            if n == 1:
                r, counter = 0, 0
            else:
                limit = (2**256 // n) * n
                prefix = lp('polystore/audit-position/v2') + ctx + SEED + u(i, 8)
                for counter in range(256):
                    x = int.from_bytes(hashlib.sha256(prefix + u(counter, 4)).digest(), 'big')
                    if x < limit:
                        r = x % n
                        break
                else:
                    raise ValueError('exhausted')
            p = available[r]
            available[r] = available[-1]
            available.pop()
            sample = challenge(ctx, i, values['metadata_mdus'] + p // rows, values['slot'] * rows + p % rows)
            sample.update(population_index=p, position_counter=counter)
            samples.append(sample)
    vectors['vectors'][name] = {'context_hex': wire.hex(), 'context_hash': ctx.hex(), 'population': population, 'samples': samples}

assert vectors == GOLDEN, 'independent v2 transcript/sample/point vectors drifted'
print('independent v2 session and audit vectors match')
