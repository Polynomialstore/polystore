import { Outlet, Link } from "react-router-dom";

export const Layout = () => {
  return (
    <div className="min-h-screen bg-background font-sans antialiased">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="text-xl font-bold flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-primary-foreground font-mono">N</div>
            NilStore
          </Link>
          <div className="hidden md:flex gap-8 text-sm font-medium text-muted-foreground">
            <Link to="/technology" className="hover:text-foreground transition-colors">Technology</Link>
            <Link to="/testnet" className="hover:text-foreground transition-colors">Testnet</Link>
            <Link to="/leaderboard" className="hover:text-foreground transition-colors">Leaderboard</Link>
            <Link to="/economy" className="hover:text-foreground transition-colors">Economy</Link>
            <Link to="/s3-adapter" className="hover:text-foreground transition-colors">S3 Adapter</Link>
            <Link to="/governance" className="hover:text-foreground transition-colors">Governance</Link>
            <a href="#" className="hover:text-foreground transition-colors">GitHub</a>
          </div>
          <button className="bg-foreground text-background px-4 py-2 rounded-full text-sm font-medium hover:opacity-90">
            Launch App
          </button>
        </div>
      </nav>

      <main>
        <Outlet />
      </main>

      <footer className="py-12 border-t bg-secondary/10 mt-24">
        <div className="container mx-auto px-4 text-center text-muted-foreground text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8 text-left max-w-4xl mx-auto">
            <div>
              <h4 className="font-bold mb-4 text-foreground">Core Tech</h4>
              <ul className="space-y-2">
                <li><Link to="/technology/sharding">Data Sharding</Link></li>
                <li><Link to="/technology/kzg">KZG Commitments</Link></li>
                <li><Link to="/technology/sealing">Proof of Seal</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-bold mb-4 text-foreground">Resources</h4>
              <ul className="space-y-2">
                <li><Link to="/testnet">Testnet Guide</Link></li>
                <li><a href="#">Whitepaper</a></li>
                <li><a href="#">GitHub</a></li>
                <li><a href="#">CLI Tool</a></li>
              </ul>
            </div>
          </div>
          <p>© 2025 NilStore Network. Open Source.</p>
        </div>
      </footer>
    </div>
  );
};
