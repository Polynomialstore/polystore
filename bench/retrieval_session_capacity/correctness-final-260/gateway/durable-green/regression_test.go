package main
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
