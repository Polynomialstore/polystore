import { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, ShieldCheck, Coins, Network, Scale } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const faqs = [
  {
    category: "General",
    icon: <Network className="w-5 h-5 text-blue-500" />,
    questions: [
      {
        q: "What is NilStore?",
        a: <>
          NilStore is a decentralized storage network that works like a public cloud (think S3) but runs on a community of independent nodes.
          Unlike other networks that rely on expensive sealing hardware, NilStore uses <strong>KZG commitments</strong> and erasure coding to keep data verifiable, retrievable, and censorship-resistant.
        </>
      },
      {
        q: "What is the 'Nilmanifold'?",
        a: "It is a precise mathematical metaphor for our network's architecture. In geometry, a Nilmanifold is a compact, homogeneous space derived from a nilpotent Lie group. 'Homogeneous' means the space looks the same from every point—there are no privileged centers. NilStore mirrors this: every node is topologically equal, and data flows fluidly across the network to balance load and heal failures, governed by equations analogous to Ricci Flow (which smooths out irregularities/curvature over time)."
      }
    ]
  },
  {
    category: "Comparison",
    icon: <Scale className="w-5 h-5 text-purple-500" />,
    questions: [
      {
        q: "How does NilStore compare to Filecoin?",
        a: <>
          <p><strong>The Hardware Barrier.</strong> Filecoin relies on "Proof of Replication" (PoRep), which requires massive GPU clusters to seal data. This limits mining to industrial data centers.</p>
          <p className="mt-2"><strong>NilStore's Advantage:</strong> We replaced sealing with <strong>KZG Commitments</strong>. This math is 100x lighter to compute. You can run a NilStore node on a standard server or high-end gaming PC, democratizing access.</p>
        </>
      },
      {
        q: "How does NilStore compare to Arweave?",
        a: <>
          <p><strong>The Endowment Model.</strong> Arweave focuses on "Permanence" via a one-time endowment fee. This is great for NFTs but expensive for dynamic data or high-performance retrieval.</p>
          <p className="mt-2"><strong>NilStore's Advantage:</strong> We focus on <strong>Performance</strong>. Our Unified Liveness model treats storage as a high-speed CDN. We are built for dynamic applications (AI models, videos, dApps) that need speed and predictable monthly billing, not just archival.</p>
        </>
      },
      {
        q: "How does NilStore compare to Walrus (Sui)?",
        a: <>
          <p><strong>The Blob Approach.</strong> Walrus uses "Red Stuff" erasure coding for blobs on Sui. It's efficient but tightly coupled to the Sui ecosystem.</p>
          <p className="mt-2"><strong>NilStore's Advantage:</strong> We are an <strong>AppChain</strong> built on Cosmos. This gives us sovereignty over our consensus and economics. Our "Unified Liveness" (User Retrieval = Storage Proof) is a unique economic innovation that ensures providers are paid for <em>serving</em> data, not just hoarding it.</p>
        </>
      },
      {
        q: "How does NilStore compare to Storj?",
        a: <>
          <p><strong>Centralized Coordination.</strong> Storj offers great S3 compatibility but relies on centralized "Satellites" for metadata and payments. It's "Decentralized Storage, Centralized Management."</p>
          <p className="mt-2"><strong>NilStore's Advantage:</strong> We are <strong>Fully Decentralized</strong>. The blockchain itself manages metadata, payments, and repair logic. There is no central "Satellite" to shut down or censor your account.</p>
        </>
      }
    ]
  },
  {
    category: "Technology",
    icon: <ShieldCheck className="w-5 h-5 text-green-500" />,
    questions: [
      {
        q: "What are KZG Commitments?",
        a: "Think of a KZG commitment as a 'cryptographic fingerprint' for a blob. NilStore commits to each 128 KiB blob with a 48-byte commitment. 64 blobs make up an 8 MiB MDU, and the deal’s manifest root binds all MDUs together for efficient verification."
      },
      {
        q: "What is 'Proof-of-Delayed-Encode' (PoDE)?",
        a: "PoDE was our initial timing-based mechanism. We have evolved this into the **Performance Market**. Instead of a binary 'Pass/Fail' based on a synthetic delay, we now tier rewards based on actual response speed. Faster nodes (Platinum) earn more than slow ones (Gold/Silver), implicitly filtering out lazy providers without brittle timing constants."
      },
      {
        q: "What is Unified Liveness?",
        a: "In most networks, 'serving a user' and 'proving you have data' are separate tasks. In NilStore, they are the same. Retrieval sessions are opened on-chain; providers serve data with KZG proofs, and confirmed sessions become the liveness signal used for rewards."
      },
      {
        q: "Why 8 MiB Data Units?",
        a: "We use 8 MiB Mega-Data Units (MDUs) to optimize throughput. Each MDU is 64 × 128 KiB blobs, which aligns with KZG verification while keeping on-chain updates compact."
      },
      {
        q: "Can I delete my data?",
        a: "Yes. NilStore supports **Crypto-Erasure**. When you upload a file, it is encrypted client-side. If you want to 'delete' it, you simply destroy the encryption key. The data remaining on the network becomes mathematically irretrievable noise, effectively erasing it from existence."
      },
      {
        q: "What are external resources to learn about the technology?",
        a: (
          <span className="space-y-2 block">
            <span className="block">NilStore relies on cutting-edge cryptography also used in Ethereum's scaling roadmap (EIP-4844). Here are some excellent resources to understand the math:</span>
            <a 
              href="https://scroll.io/blog/kzg" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
            >
              <ExternalLink className="w-4 h-4" /> KZG in Practice (Scroll.io)
            </a>
            <br/>
            <a 
              href="https://dankradfeist.de/ethereum/2020/06/16/kate-polynomial-commitments.html" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
            >
              <ExternalLink className="w-4 h-4" /> Kate Polynomial Commitments (Dankrad Feist)
            </a>
          </span>
        )
      }
    ]
  },
  {
    category: "Economics",
    icon: <Coins className="w-5 h-5 text-yellow-500" />,
    questions: [
      {
        q: "How do I earn rewards?",
        a: <>
          You can join the network as a Storage Provider. You earn tokens in two ways:
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>Performance Rewards:</strong> For serving retrieval sessions quickly (tiered by latency).</li>
            <li><strong>Bandwidth Fees:</strong> For delivering verified data during retrieval sessions.</li>
          </ul>
          On devnet the base denom is <strong>stake</strong>; token branding is still evolving.
        </>
      },
      {
        q: "What happens if a node goes offline?",
        a: "We use Erasure Coding (like RAID for the internet). A file is striped across K+M slots (default 8+4). Any K slots can reconstruct the data, so the network can repair missing shards and keep deals healthy."
      }
    ]
  }
];

export const FAQ = () => {
  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-4xl">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold mb-4 text-foreground">Frequently Asked Questions</h1>
        <p className="text-xl text-muted-foreground">
          Everything you need to know about the NilStore Network, Technology, and Economics.
        </p>
      </div>

      <div className="space-y-12">
        {faqs.map((section, idx) => (
          <div key={idx} className="bg-card border border-border rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2 text-foreground border-b border-border pb-4">
              {section.icon}
              {section.category}
            </h2>
            <div className="space-y-4">
              {section.questions.map((item, qIdx) => (
                <AccordionItem key={qIdx} question={item.q} answer={item.a} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const AccordionItem = ({ question, answer }: { question: string, answer: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border border-border rounded-xl bg-background/50 overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-secondary/50 transition-colors"
      >
        <span className="font-medium text-foreground pr-8">{question}</span>
        {isOpen ? <ChevronUp className="w-5 h-5 text-muted-foreground" /> : <ChevronDown className="w-5 h-5 text-muted-foreground" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="p-4 pt-0 text-muted-foreground text-sm leading-relaxed border-t border-border/50 mt-2">
              {answer}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
