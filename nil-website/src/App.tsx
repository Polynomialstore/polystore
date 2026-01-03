import { HashRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Technology } from "./pages/Technology";
import { TechnologyLayout } from "./pages/TechnologyLayout";
import { KZGDeepDive } from "./pages/KZGDeepDive";
import { ArgonDeepDive } from "./pages/ArgonDeepDive";
import { ShardingDeepDive } from "./pages/ShardingDeepDive";
import { TestnetDocs } from "./pages/TestnetDocs";
import { Leaderboard } from "./pages/Leaderboard";
import { S3AdapterDocs } from "./pages/S3AdapterDocs";
import { GovernanceDocs } from "./pages/GovernanceDocs";
import { EconomyDashboard } from "./pages/EconomyDashboard";
import { AdversarialSimulation } from "./pages/AdversarialSimulation";
import { Security } from "./pages/Security";
import { PerformanceReport } from "./pages/PerformanceReport";
import { Litepaper, Whitepaper } from "./pages/Papers"; // Import both
import { ProofsDashboard } from "./pages/ProofsDashboard";
import { FAQ } from "./pages/FAQ";
import { LogoShowcase } from "./pages/LogoShowcase";
import { ThemeProvider } from "./context/ThemeContext";
import { TransportProvider } from "./context/TransportContext";
import { Dashboard } from "./components/Dashboard";
import { Devnet } from "./pages/Devnet";

function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="nilstore-theme">
      <TransportProvider>
        <HashRouter>
          <Routes>
            <Route path="/brand" element={<LogoShowcase />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="devnet" element={<Devnet />} />
              <Route path="testnet" element={<TestnetDocs />} />
              <Route path="leaderboard" element={<Leaderboard />} />
              <Route path="performance" element={<PerformanceReport />} />
              <Route path="proofs" element={<ProofsDashboard />} />
              <Route path="s3-adapter" element={<S3AdapterDocs />} />
              <Route path="governance" element={<GovernanceDocs />} />
              <Route path="economy" element={<EconomyDashboard />} />
              <Route path="security" element={<Security />} />
              <Route path="adversarial-simulation" element={<AdversarialSimulation />} />
              <Route path="litepaper" element={<Litepaper />} />
              <Route path="whitepaper" element={<Whitepaper />} />
              <Route path="faq" element={<FAQ />} />
              <Route path="technology" element={<TechnologyLayout />}>
                <Route index element={<Technology />} />
                <Route path="sharding" element={<ShardingDeepDive />} />
                <Route path="kzg" element={<KZGDeepDive />} />
                <Route path="pode" element={<ArgonDeepDive />} />
                <Route path="sealing" element={<ArgonDeepDive />} />
              </Route>
            </Route>
          </Routes>
        </HashRouter>
      </TransportProvider>
    </ThemeProvider>
  );
}

export default App;
