import json,os,pathlib,shutil,signal,subprocess,time
r=pathlib.Path(__file__).parent
cwd='/Users/michaelseiler/dev/polynomialstore/polystore/polystorechain'
args=['go','test','-mod=readonly','-p=2','-overlay='+str(r/'overlay.json'),'./app','-run','TestHistorical(CaughtChildRollback|ChildCryptoGas)','-count=1','-timeout=90s','-v']
env=dict(os.environ,GOMAXPROCS='2',GOPROXY='off',CGO_LDFLAGS='-L/Users/michaelseiler/dev/polynomialstore/polystore/polystore_core/target/release',DYLD_LIBRARY_PATH='/Users/michaelseiler/dev/polynomialstore/polystore/polystore_core/target/release')
report=dict(command=args,floor_bytes=600*1024**2,minimum_free_bytes=shutil.disk_usage(cwd).free)
with (r/'all-red.log').open('w') as log:
 p=subprocess.Popen(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 deadline=time.monotonic()+300
 while p.poll() is None:
  free=shutil.disk_usage(cwd).free;report['minimum_free_bytes']=min(free,report['minimum_free_bytes'])
  if free<report['floor_bytes'] or time.monotonic()>deadline:
   report['stopped']='disk floor or wall deadline';os.killpg(p.pid,signal.SIGTERM);break
  time.sleep(1)
 try:p.wait(timeout=20)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 report['returncode']=p.returncode
(r/'all-red-guard.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
