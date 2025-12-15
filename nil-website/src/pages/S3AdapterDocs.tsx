import { Terminal, Globe, Database } from "lucide-react";

export const S3AdapterDocs = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold mb-4 text-foreground">S3 Adapter & Web2 Gateway</h1>
        <p className="text-xl text-muted-foreground">
          NilStore provides a native Go-based adapter (`nil_gateway`) that translates standard S3 `PUT` and `GET` requests into sharded, verifiable storage transactions on the NilChain.
        </p>
      </div>

      <div className="grid gap-12">
        {/* Architecture */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">How it Works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-card p-6 rounded-xl border border-border">
              <Globe className="w-8 h-8 text-blue-400 mb-4" />
              <h3 className="font-bold text-lg text-foreground">1. S3 Ingestion</h3>
              <p className="text-sm text-muted-foreground mt-2">
                The adapter listens for standard HTTP/S3 requests. When a file is uploaded via `PUT`, it is temporarily buffered.
              </p>
            </div>
            <div className="bg-card p-6 rounded-xl border border-border">
              <Database className="w-8 h-8 text-green-400 mb-4" />
              <h3 className="font-bold text-lg text-foreground">2. Sharding & Binding</h3>
              <p className="text-sm text-muted-foreground mt-2">
                The file is split into <strong>8 MiB Mega-Data Units (MDUs)</strong>. The adapter generates a <strong>Manifest</strong> containing KZG commitments for each MDU, producing a single 48-byte Root Hash.
              </p>
            </div>
            <div className="bg-card p-6 rounded-xl border border-border">
              <Terminal className="w-8 h-8 text-purple-400 mb-4" />
              <h3 className="font-bold text-lg text-foreground">3. Content Commitment</h3>
              <p className="text-sm text-muted-foreground mt-2">
                The Root Hash is returned to the user or automatically committed to an active Storage Deal via `MsgUpdateDealContent`, binding the data to the network's capacity.
              </p>
            </div>
          </div>
        </section>

        {/* API Reference */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">API Reference</h2>
          
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
                <span className="bg-blue-500/20 text-blue-400 px-2 py-1 rounded text-xs font-mono">PUT</span>
                /api/v1/object/{'{key}'}
              </h3>
              <p className="text-sm text-muted-foreground mb-2">Uploads and shards a file.</p>
              <div className="bg-background/50 p-4 rounded-lg font-mono text-sm text-foreground overflow-x-auto border border-border">
                curl -X PUT --data-binary @my_photo.jpg http://localhost:8080/api/v1/object/my_photo.jpg
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2 flex items-center gap-2">
                <span className="bg-green-500/20 text-green-400 px-2 py-1 rounded text-xs font-mono">GET</span>
                /api/v1/object/{'{key}'}
              </h3>
              <p className="text-sm text-muted-foreground mb-2">Retrieves a file (reassembling shards).</p>
              <div className="bg-background/50 p-4 rounded-lg font-mono text-sm text-foreground overflow-x-auto border border-border">
                curl -O http://localhost:8080/api/v1/object/my_photo.jpg
              </div>
            </div>
          </div>
        </section>

        {/* Setup */}
        <section className="space-y-4">
          <h2 className="text-2xl font-bold border-b pb-2 text-foreground">Running the Adapter</h2>
          <div className="bg-card p-6 rounded-xl font-mono text-sm text-muted-foreground border border-border">
            <p className="text-muted-foreground"># 1. Build the S3 Service</p>
            <p>$ cd nil_gateway</p>
            <p>$ go build</p>
            <br/>
            <p className="text-muted-foreground"># 2. Ensure dependencies (CLI & Trusted Setup)</p>
            <p>$ cd ../nil_cli && cargo build</p>
            <br/>
            <p className="text-muted-foreground"># 3. Run</p>
            <p>$ ./nil_gateway</p>
          </div>
        </section>
      </div>
    </div>
  );
};
