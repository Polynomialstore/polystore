exec(open('/tmp/polystore-254-execution/260-historical-gateway-counterexamples/prepare.py').read().split('identities=[]')[0])
identities=[]
for label,rev in [('red','76c8653'),('green','76653383')]:
 out=root/('durable-'+label);out.mkdir(exist_ok=True)
 raw=source(rev,'polystore_gateway/fetch_session_onchain.go');main=source(rev,'polystore_gateway/main.go')
 (out/'original_fetch_session_onchain.go.txt').write_text(raw)
 code='package main\nimport("encoding/json";"fmt";bolt "go.etcd.io/bbolt";"polystorechain/x/polystorechain/types")\n'
 code+=function(raw,'storeOnChainSessionProof')+'\n'+function(raw,'loadOnChainSessionProofs')+'\n'
 (out/'store.go').write_text(code)
 helper='package main\nimport("encoding/hex";"fmt";"strings";bolt "go.etcd.io/bbolt")\nvar sessionDB *bolt.DB\nvar onChainSessionProofsBucket=[]byte("onchain_session_proofs")\n'
 helper+=function(main,'parseSessionIDHex')+'\n'
 (out/'helpers.go').write_text(helper)
 if label=='green':
  (out/'strict_json.go').write_text('package main\nimport("bytes";"encoding/json";"fmt";"io";"strings";"unicode/utf8";"polystorechain/x/polystorechain/types")\nconst maxRetrievalMetadataBytes=128*1024\n'+function(source(rev,'polystore_gateway/retrieval_query.go'),'validateJSONObject')+'\n'+function(raw,'decodeLegacySessionProofs')+'\n')
 (out/'regression_test.go').write_text('''package main
import("bytes";"path/filepath";"strings";"testing";bolt "go.etcd.io/bbolt";"polystorechain/x/polystorechain/types")
func TestLegacyCorruptProofMustRemainDurable(t *testing.T){
 var err error;sessionDB,err=bolt.Open(filepath.Join(t.TempDir(),"proofs.db"),0600,nil);if err!=nil{t.Fatal(err)};defer sessionDB.Close()
 id:="0x"+strings.Repeat("a",64);bad:=[]byte(`[{"mdu_index":`)
 if err=sessionDB.Update(func(tx *bolt.Tx)error{b,e:=tx.CreateBucketIfNotExists(onChainSessionProofsBucket);if e!=nil{return e};return b.Put([]byte(id),bad)});err!=nil{t.Fatal(err)}
 err=storeOnChainSessionProof(id,types.ChainedProof{MduIndex:1,BlobIndex:64})
 if err==nil{t.Error("corruption overwritten: store returned success")}
 if _,err=loadOnChainSessionProofs(id);err==nil{t.Error("corruption became valid or absent")}
 if err=sessionDB.View(func(tx *bolt.Tx)error{actual:=tx.Bucket(onChainSessionProofsBucket).Get([]byte(id));if !bytes.Equal(actual,bad){t.Errorf("corrupt record changed: before=%q after=%q",bad,actual)};return nil});err!=nil{t.Fatal(err)}
}
''')
 mod=(repo/'polystore_gateway/go.mod').read_text().replace('replace polystorechain => ../polystorechain','replace polystorechain => '+str(repo/'polystorechain'))
 (out/'go.mod').write_text(mod);(out/'go.sum').write_bytes((repo/'polystore_gateway/go.sum').read_bytes())
 identities.append(dict(label=label,commit=subprocess.check_output(['git','rev-parse',rev],cwd=repo).decode().strip(),source='polystore_gateway/fetch_session_onchain.go',blob=subprocess.check_output(['git','rev-parse',rev+':polystore_gateway/fetch_session_onchain.go'],cwd=repo).decode().strip(),sha256=hashlib.sha256(raw.encode()).hexdigest(),scope='Exact store/load and parseSessionIDHex functions. Real bbolt temp DB; real cached chain types package at76653383, ChainedProof declaration identical to original76c8653. No chain keeper/native verifier/setup loaded.'))
(root/'durable-source-identities.json').write_text(json.dumps(identities,indent=2)+'\n')
