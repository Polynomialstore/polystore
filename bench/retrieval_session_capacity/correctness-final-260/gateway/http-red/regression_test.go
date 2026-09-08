package main
import("context";"fmt";"net/http";"net/http/httptest";"testing";"time")
func TestMalformedHTTP200MustNotReportCommittedSuccess(t *testing.T){
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){fmt.Fprint(w,`{}`)}));defer srv.Close();lcdBase=srv.URL
 ctx,cancel:=context.WithTimeout(context.Background(),2*time.Second);defer cancel()
 hash,err:=submitTxAndWait(ctx)
 if err==nil{t.Fatalf("unsafe committed success for HTTP200 {}: hash=%s error=%v",hash,err)}
 t.Logf("safe response: hash=%s error=%v",hash,err)
}
