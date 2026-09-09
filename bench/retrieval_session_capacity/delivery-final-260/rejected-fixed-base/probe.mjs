import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
const bits=Number(process.argv[2]);
const root=(await import('node:path')).resolve(process.argv[3])+'/';
const {default:init,PolyStoreWasm}=await import(root+'polystore_core.js');
const binary=await fs.readFile(root+'polystore_core_bg.wasm');
const setup=await fs.readFile(process.argv[4]);
const exports=await init({module_or_path:binary});
const start=performance.now();const wasm=new PolyStoreWasm(setup);const initMs=performance.now()-start;
const blob=crypto.createCipheriv('aes-256-ctr',Buffer.alloc(32,0x57),Buffer.alloc(16)).update(Buffer.alloc(131072));
for(let i=0;i<blob.length;i+=32)blob[i]=0;
const run=(fixed,input=blob)=>{const t=performance.now();const result=Buffer.from(fixed?wasm.experiment_fixed_base(input,bits):wasm.commit_received_blob(input));return {ms:performance.now()-t,result};};
const initialMemory=exports.memory.buffer.byteLength;
const cold=run(true); const pairs=[];
for(let i=0;i<6;i++){const first=run(i%2===0),second=run(i%2!==0);const a=i%2===0?second:first,b=i%2===0?first:second;if(!a.result.equals(b.result))throw Error('nonconstant parity');if(i)pairs.push({baselineMs:a.ms,fixedMs:b.ms});}
const boundary=Buffer.from('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000','hex');
const zero=Buffer.alloc(131072),sparse=Buffer.alloc(131072),maximum=Buffer.alloc(131072);sparse[31]=1;sparse[131071]=2;for(let i=0;i<maximum.length;i+=32)boundary.copy(maximum,i);
for(const [name,input] of Object.entries({zero,sparse,maximum})){if(!run(false,input).result.equals(run(true,input).result))throw Error(name+' parity');}
const invalid=Buffer.from(zero);Buffer.from('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001','hex').copy(invalid,131040);
for(const input of [invalid,Buffer.alloc(1)])for(const fixed of [false,true]){let rejected=false;try{run(fixed,input);}catch{rejected=true;}if(!rejected)throw Error('invalid accepted');}
console.log(JSON.stringify({bits,tableMiB:3*2**(bits-4),node:process.version,wasmSHA256:crypto.createHash('sha256').update(binary).digest('hex'),setupSHA256:crypto.createHash('sha256').update(setup).digest('hex'),fixtureSHA256:crypto.createHash('sha256').update(blob).digest('hex'),initMs,coldMs:cold.ms,pairs,initialMemory,finalMemory:exports.memory.buffer.byteLength,maxRSSKiB:process.resourceUsage().maxRSS,parity:'nonconstant,zero,sparse,all r-1; invalid length and r at last cell rejected'},null,2));
wasm.free();
