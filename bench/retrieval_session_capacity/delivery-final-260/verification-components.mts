import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
const root=(await import('node:path')).resolve(process.argv[2] || '.')+'/'
const {default:init,PolyStoreWasm}=await import(root+'polystore-website/public/wasm/polystore_core.js')
const read=(p:string)=>fs.readFile(root+p), sha=(b:Uint8Array)=>crypto.createHash('sha256').update(b).digest('hex')
const binary=await read('polystore-website/public/wasm/polystore_core_bg.wasm'), setup=await read('polystore-website/public/trusted_setup.txt')
const qRaw=await read('testdata/retrieval-window-v2/session.json'), mRaw=await read('testdata/retrieval-window-v2/metadata.json'), bytes=await read('testdata/retrieval-window-v2/window.bin')
const q=JSON.parse(String(qRaw)), m=JSON.parse(String(mRaw)), b64=(x:string)=>Buffer.from(x,'base64')
const proofs=m.proofs
const parts=[Buffer.from('PSB1'),Buffer.alloc(2),Buffer.alloc(4),b64(q.session.manifest_root),b64(q.challenge_context_hash),b64(q.challenge_seed)]
parts[1].writeUInt16BE(proofs.length);parts[2].writeUInt32BE(96)
for(const p of proofs){const index=Buffer.alloc(12);index.writeBigUInt64BE(BigInt(p.mdu_index));index.writeUInt32BE(p.blob_index??0,8);parts.push(index)
 for(const key of ['mdu_root_fr','root_table_du_commitment','manifest_opening','blob_commitment','z_value','y_value','kzg_opening_proof'])parts.push(b64(p[key]))
 const paths=Buffer.alloc(4);paths.writeUInt16BE(p.root_table_du_merkle_path.length);paths.writeUInt16BE(p.merkle_path.length,2);parts.push(paths)
 for(const sibling of [...p.root_table_du_merkle_path,...p.merkle_path])parts.push(b64(sibling))
}
const actualBatch=Buffer.concat(parts)
function verifyComponents(session:any,envelope:any,proxy:any,challenge:any) {
 if(!Buffer.from(challenge.challenge_context_hash(session.context)).equals(session.contextHash))throw Error('context mismatch')
 if(challenge.derive_challenges(session.context,session.seed).length!==120)throw Error('challenge coverage')
 if(!proxy.verify_polyfs_session_batch(actualBatch))throw Error('invalid fixture proof')
 for(let i=0;i<2;i++)if(!Buffer.from(proxy.commit_received_blob(bytes.subarray(i*131072,(i+1)*131072))).equals(b64(proofs[i].blob_commitment)))throw Error('byte commitment mismatch')
 return envelope.bytes
}
const session:any={seed:b64(q.challenge_seed),context:b64(q.challenge_context),contextHash:b64(q.challenge_context_hash),height:12n,openedHeight:10n,expiry:50n,
 window:{blobCount:2,mduIndex:2n,startBlobIndex:8},pin:{root:'0x'+b64(q.session.manifest_root).toString('hex'),leafCount:96}}
const t0=performance.now();await init({module_or_path:binary});const wasm=new PolyStoreWasm(setup);const initMs=performance.now()-t0
const results=[]
for(let repeat=0;repeat<4;repeat++) {
 let batchMs=0,commitMs=0; const perBlob=[]
 const proxy:any={verify_polyfs_session_batch(input:Uint8Array){const t=performance.now();const ok=wasm.verify_polyfs_session_batch(input);batchMs+=performance.now()-t;return ok},
 commit_received_blob(input:Uint8Array){const t=performance.now();const c=wasm.commit_received_blob(input);const elapsed=performance.now()-t;perBlob.push(elapsed);commitMs+=elapsed;return c}}
 const t=performance.now(); const out=verifyComponents(session,{proofs,bytes},proxy,PolyStoreWasm);const totalMs=performance.now()-t
 if(out!==bytes)throw Error('payload identity mismatch')
 results.push({totalMs,batchMs,commitMs,otherMs:totalMs-batchMs-commitMs,perBlob})
}
const batch=await read('polystore_core/tests/testdata/session-batch-input.bin');const independentBatch=[]
for(let i=0;i<4;i++){const t=performance.now();if(!wasm.verify_polyfs_session_batch(batch))throw Error('batch rejected');independentBatch.push(performance.now()-t)}
const profile=wasm.commit_blobs_profiled(bytes)
console.log(JSON.stringify({scope:'local Node existing WASM, real nonconstant two-blob fixture; not hosted timing; exact runtime source provenance unestablished',node:process.version,wasmSHA256:sha(binary),setupSHA256:sha(setup),fixtureHashes:{session:sha(qRaw),metadata:sha(mRaw),bytes:sha(bytes),batch:sha(batch)},initMs,warmup:results[0],repeats:results.slice(1),independentBatch:{proofs:batch.readUInt16BE(4),warmupMs:independentBatch[0],measureMs:independentBatch.slice(1)},existingProducerProfile:profile},null,2))
wasm.free()
