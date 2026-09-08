import base64, ctypes, json, pathlib, sys
library, setup, case = sys.argv[1:]
lib = ctypes.CDLL(library)
lib.polystore_init.argtypes = [ctypes.c_char_p]
lib.polystore_init.restype = ctypes.c_int
if case == 'trailer':
    data = bytearray(pathlib.Path(setup).read_bytes())
    data[-2] = ord('1') if data[-2] == ord('0') else ord('0')
    altered = pathlib.Path(__file__).with_name('altered-setup.txt')
    altered.write_bytes(data)
    result = lib.polystore_init(str(altered).encode())
    print(json.dumps(dict(case=case, result=result)), flush=True)
    assert result < 0, 'changed setup trailer must be rejected'
else:
    assert lib.polystore_init(setup.encode()) == 0
    if case == 'reinit':
        result = lib.polystore_init(b'/nonexistent-polystore-regression-setup.txt')
        print(json.dumps(dict(case=case, result=result)), flush=True)
        assert result < 0, 'reinitialization must authenticate requested file'
    elif case == 'merkle':
        p = json.loads(pathlib.Path(__file__).with_name('proof-fixture.json').read_text())['proofs'][0]
        decode = base64.b64decode
        buf = lambda value: ctypes.create_string_buffer(value, len(value))
        f = lib.polystore_verify_mdu_proof
        f.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        f.restype = ctypes.c_int
        path = b''.join(map(decode, p['merkle_path']))
        def verify(path):
            return f(buf(decode(p['mdu_root_fr'])), buf(decode(p['blob_commitment'])), buf(path), len(path), 0, 96, buf(decode(p['z_value'])), buf(decode(p['y_value'])), buf(decode(p['kzg_opening_proof'])))
        valid = verify(path)
        extra = verify(path + bytes(32))
        print(json.dumps(dict(case=case, valid=valid, extra_sibling=extra)), flush=True)
        assert valid == 1, 'control proof must verify'
        assert extra != 1, 'unused sibling must be rejected'
