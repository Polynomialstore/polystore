import pathlib,subprocess,re,json,hashlib
root=pathlib.Path('/tmp/polystore-254-execution/260-historical-gateway-counterexamples')
repo=pathlib.Path('/Users/michaelseiler/dev/polynomialstore/polystore-260-saturation')
def source(rev,path):return subprocess.check_output(['git','show',rev+':'+path],cwd=repo).decode()
def function(s,name):return re.search(r'(?m)^func '+name+r'\([^\n]*[\s\S]*?^}',s).group()
identities=[]
for label,rev in [('red','76c8653'),('green','89aa18de')]:
 out=root/('http-'+label);out.mkdir(exist_ok=True)
 commit=subprocess.check_output(['git','rev-parse',rev],cwd=repo).decode().strip();main=source(rev,'polystore_gateway/main.go')
 raw=source(rev,'polystore_gateway/tx_submit.go');(out/'tx_submit.go').write_text(raw)
 helper='package main\nimport("bytes";"context";"fmt";"regexp";"strings")\nvar lcdBase string\nvar txHashRe = regexp.MustCompile(`txhash:\\s*([A-Fa-f0-9]+)`)\n'
 helper+=function(main,'extractJSONBody')+'\n'+function(main,'extractTxHash')+'\n'+re.search(r'(?m)^type txBroadcastResponse struct {[\s\S]*?^}',main).group()+'\n'
 helper+='func runTxWithRetry(context.Context, ...string)([]byte,error){return []byte(fmt.Sprintf(`{"txhash":"%s","code":0}`, strings.Repeat("A",64))),nil}\n'
 (out/'helpers.go').write_text(helper)
 if label=='green':
  (out/'strict_json.go').write_text('package main\nimport("bytes";"encoding/json";"fmt";"io";"strings";"unicode/utf8")\n'+function(source(rev,'polystore_gateway/retrieval_query.go'),'validateJSONObject')+'\n')
 (out/'regression_test.go').write_text('''package main
import("context";"fmt";"net/http";"net/http/httptest";"testing";"time")
func TestMalformedHTTP200MustNotReportCommittedSuccess(t *testing.T){
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){fmt.Fprint(w,`{}`)}));defer srv.Close();lcdBase=srv.URL
 ctx,cancel:=context.WithTimeout(context.Background(),2*time.Second);defer cancel()
 hash,err:=submitTxAndWait(ctx)
 if err==nil{t.Fatalf("unsafe committed success for HTTP200 {}: hash=%s error=%v",hash,err)}
 t.Logf("safe response: hash=%s error=%v",hash,err)
}
''')
 (out/'go.mod').write_text('module historical-http-counterexample\ngo 1.25.5\n')
 identities.append(dict(label=label,commit=commit,source='polystore_gateway/tx_submit.go',blob=subprocess.check_output(['git','rev-parse',rev+':polystore_gateway/tx_submit.go'],cwd=repo).decode().strip(),sha256=hashlib.sha256(raw.encode()).hexdigest(),scope='Exact tx_submit.go and extracted original parsing helpers; successful broadcast command stub; real httptest HTTP200 {}; no chain/native/setup loaded.'))
(root/'source-identities.json').write_text(json.dumps(identities,indent=2)+'\n')
