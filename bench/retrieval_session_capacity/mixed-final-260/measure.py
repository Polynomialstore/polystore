import hashlib,json,os,re,statistics,subprocess,sys
from pathlib import Path
sys.path.insert(0,'/Users/michaelseiler/dev/polynomialstore/polystore-260-saturation/scripts')
import retrieval_bench_artifact as artifact
out=Path('/tmp/polystore-254-execution/260-mixed-final-comparison')
out.mkdir(exist_ok=False)
base=Path('/Users/michaelseiler/dev/polynomialstore')
variants={
 'baseline':(base/'polystore-255-audits',Path('/tmp/polystore-254-execution/260-mixed-baseline-smoke/keeper-mixed.test')),
 'candidate':(base/'polystore-260-saturation',Path('/tmp/polystore-254-execution/260-mixed-final-candidate/keeper-mixed.test'))}
rows=[]
for repeat in range(5):
 for name in (['baseline','candidate'] if repeat%2==0 else ['candidate','baseline']):
  tree,binary=variants[name]
  label=f'{repeat+1:02}-{name}'
  (out/(label+'-host.txt')).write_text(subprocess.check_output(['ps','-Ao','pid,pcpu,comm','-r'],text=True))
  library=tree/'polystore_core/target/release/libpolystore_core.dylib'
  env=dict(os.environ,GOMAXPROCS='2',DYLD_LIBRARY_PATH=str(library.parent),POLYSTORE_TRUSTED_SETUP=str(tree/'polystorechain/trusted_setup.txt'))
  argv=['/usr/bin/time','-l',str(binary),'-test.run=^$','-test.bench=^BenchmarkSubmitRetrievalSessionProofV2Mixed$','-test.benchtime=3x','-test.count=1','-test.timeout=120s']
  os.chdir(tree/'polystorechain/x/polystorechain/keeper')
  result=artifact.run_bounded_command(argv,artifact.monotonic_ns()+150*10**9,env=env)
  text=result.stdout+result.stderr
  (out/(label+'.log')).write_text(text)
  if result.returncode or not re.search(r'^PASS$',text,re.M): raise RuntimeError(label+' failed; retained raw log')
  line=re.search(r'^BenchmarkSubmitRetrievalSessionProofV2Mixed-2\s+3\s+(.+)$',text,re.M)
  if not line: raise ValueError('missing exact benchmark row')
  metrics={unit:float(value) for value,unit in re.findall(r'([0-9.]+)\s+(\S+)',line[1])}
  assert metrics['proofs/op']==52 and metrics['sessions/op']==6
  timing=re.search(r'([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys',text)
  row=dict(repeat=repeat+1,variant=name,metrics=metrics,wall_s=float(timing[1]),user_s=float(timing[2]),system_s=float(timing[3]),max_rss_bytes=int(re.search(r'(\d+)\s+maximum resident set size',text)[1]),command=argv,binary_sha256=artifact.sha256(binary),library_sha256=artifact.sha256(library),raw_sha256=artifact.sha256(out/(label+'.log')))
  rows.append(row);(out/'observations.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
summary={}
for name in variants:
 group=[r for r in rows if r['variant']==name]
 summary[name]={key:dict(median=statistics.median(r['metrics'][key] for r in group),minimum=min(r['metrics'][key] for r in group),maximum=max(r['metrics'][key] for r in group)) for key in group[0]['metrics']}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary),flush=True)
