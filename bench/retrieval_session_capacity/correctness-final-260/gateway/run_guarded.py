import os,pathlib,subprocess,time,shutil,signal,json,sys
root=pathlib.Path(__file__).parent
phase=sys.argv[1];cwd=root/phase
initial=shutil.disk_usage(root).free;start=time.monotonic();temp=root/'go-tmp';temp.mkdir(exist_ok=True)
env=dict(os.environ,GOMAXPROCS='2',GOTOOLCHAIN='local',GOPROXY='off',GOSUMDB='off',GOTMPDIR=str(temp))
command=['go','test','-p','2','-count=1','-timeout','30s','-v','.']
with (root/(phase+'.log')).open('w') as log:
 log.write('cwd='+str(cwd)+'\ncommand='+repr(command)+'\nGOMAXPROCS=2 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOTMPDIR='+str(temp)+'\n');log.flush()
 process=subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 reason=None
 while process.poll() is None:
  if initial-shutil.disk_usage(root).free>256*1024**2:reason='256 MiB incremental disk limit'
  if time.monotonic()-start>240:reason='240 second per-build limit'
  if reason:os.killpg(process.pid,signal.SIGTERM);process.wait();break
  time.sleep(.5)
 result=dict(phase=phase,command=command,exit_code=process.returncode,guard_stop=reason,elapsed_seconds=time.monotonic()-start,free_before=initial,free_after=shutil.disk_usage(root).free)
 (root/(phase+'-result.json')).write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result));print((root/(phase+'.log')).read_text()[-3000:])
