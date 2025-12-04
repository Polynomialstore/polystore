import { HashRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Technology } from "./pages/Technology";
import { TechnologyLayout } from "./pages/TechnologyLayout";
import { KZGDeepDive } from "./pages/KZGDeepDive";
import { ArgonDeepDive } from "./pages/ArgonDeepDive";
import { ShardingDeepDive } from "./pages/ShardingDeepDive";
import { TestnetDocs } from "./pages/TestnetDocs";
import { ProofProvider } from "./context/ProofContext";
import { Leaderboard } from "./pages/Leaderboard";
import { S3AdapterDocs } from "./pages/S3AdapterDocs";
import { GovernanceDocs } from "./pages/GovernanceDocs";
import { EconomyDashboard } from "./pages/EconomyDashboard";
import { AdversarialSimulation } from "./pages/AdversarialSimulation";
import { Litepaper, Whitepaper } from "./pages/Papers"; // Import both
import { FAQ } from "./pages/FAQ";
import { LogoShowcase } from "./pages/LogoShowcase";
import { ThemeProvider } from "./context/ThemeContext";

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="nilstore-theme">
      <ProofProvider>
        <HashRouter>
          <Routes>
            <Route path="/brand" element={<LogoShowcase />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="testnet" element={<TestnetDocs />} />
              <Route path="leaderboard" element={<Leaderboard />} />
              <Route path="s3-adapter" element={<S3AdapterDocs />} />
              <Route path="governance" element={<GovernanceDocs />} />
              <Route path="economy" element={<EconomyDashboard />} />
              <Route path="security" element={<AdversarialSimulation />} />
              <Route path="litepaper" element={<Litepaper />} />
              <Route path="whitepaper" element={<Whitepaper />} />
              <Route path="faq" element={<FAQ />} />
              <Route path="technology" element={<TechnologyLayout />}>
                <Route index element={<Technology />} />
                <Route path="sharding" element={<ShardingDeepDive />} />
                <Route path="kzg" element={<KZGDeepDive />} />
                <Route path="sealing" element={<ArgonDeepDive />} />
              </Route>
            </Route>
          </Routes>
        </HashRouter>
      </ProofProvider>
    </ThemeProvider>
  );
}

export default App;
