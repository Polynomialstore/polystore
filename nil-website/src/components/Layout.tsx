import { Outlet, Link } from "react-router-dom";
import { ModeToggle } from "./ModeToggle";

export const Layout = () => {
  return (
    <div className="min-h-screen bg-background font-sans antialiased text-foreground transition-colors duration-300">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="text-xl font-bold flex items-center gap-2"> {/* Removed text-foreground */}
            <div className="relative w-8 h-8">
                <img src="/logo_dark.jpg" className="absolute inset-0 w-full h-full object-contain dark:hidden" />
                <img src="/logo_light.jpg" className="absolute inset-0 w-full h-full object-contain hidden dark:block" />
            </div>
            <span 
              className="font-extrabold tracking-tight text-xl" // Matched tracking-tight and increased size
              style={{
                fontFamily: "'Montserrat', sans-serif",
                backgroundImage: "linear-gradient(90deg, #00E5FF 0%, #E056FD 50%, #7B2CBF 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 0 2px rgba(0, 229, 255, 0.2))" // Subtle shadow
              }}
            >
              NilStore
            </span>
          </Link>
          <div className="hidden md:flex gap-8 text-sm font-medium text-muted-foreground items-center">
            <Link to="/technology" className="hover:text-foreground transition-colors">Technology</Link>
            <Link to="/testnet" className="hover:text-foreground transition-colors">Testnet</Link>
            <Link to="/leaderboard" className="hover:text-foreground transition-colors">Leaderboard</Link>
            <Link to="/economy" className="hover:text-foreground transition-colors">Economy</Link>
            <Link to="/security" className="hover:text-foreground transition-colors">Security</Link>
            <Link to="/s3-adapter" className="hover:text-foreground transition-colors">S3 Adapter</Link>
            <Link to="/governance" className="hover:text-foreground transition-colors">Governance</Link>
            <Link to="/faq" className="hover:text-foreground transition-colors">FAQ</Link>
            <a href="#" className="hover:text-foreground transition-colors">GitHub</a>
            <div className="pl-4 border-l">
                <ModeToggle />
            </div>
          </div>
          <div className="md:hidden flex items-center gap-4">
             <ModeToggle />
          </div>
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
