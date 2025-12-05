import { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, ShieldCheck, Coins, Network } from 'lucide-react';
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
          Unlike other networks that rely on expensive hardware, NilStore uses advanced mathematics (Zero-Knowledge proofs) to ensure your data is safe, retrievable, and censorship-resistant.
        </>
      },
      {
        q: "How is this different from Filecoin or Arweave?",
        a: <>
          <p><strong>Speed and Efficiency.</strong> Most legacy decentralized storage networks require 'sealing'—a slow, energy-intensive process to secure data. This makes them slow to write to and requires specialized mining rigs.</p>
          <p>NilStore uses <strong>KZG Commitments</strong> (the same tech scaling Ethereum) and <strong>Proof-of-Delayed-Encode (PoDE)</strong> to verify data instantly without sealing. This means you can run a node on a standard server and users get cloud-like performance.</p>
        </>
      },
      {
        q: "What is the 'Nilmanifold'?",
        a: "It is a precise mathematical metaphor for our network's architecture. In geometry, a Nilmanifold is a compact, homogeneous space derived from a nilpotent Lie group. 'Homogeneous' means the space looks the same from every point—there are no privileged centers. NilStore mirrors this: every node is topologically equal, and data flows fluidly across the network to balance load and heal failures, governed by equations analogous to Ricci Flow (which smooths out irregularities/curvature over time)."
      }
    ]
  },
  {
    category: "Technology",
    icon: <ShieldCheck className="w-5 h-5 text-green-500" />,
    questions: [
      {
        q: "What are KZG Commitments?",
        a: "Think of a KZG commitment as a 'cryptographic fingerprint' for a file. We can compress an 8 MiB chunk of data into a tiny 48-byte signature. This signature mathematically proves the data exists and hasn't been tampered with, without needing to reveal the whole file. It's the magic that makes our network so lightweight."
      },
      {
        q: "What is 'Proof-of-Delayed-Encode' (PoDE)?",
        a: "PoDE was our initial timing-based mechanism. We have evolved this into the **Performance Market**. Instead of a binary 'Pass/Fail' based on a synthetic delay, we now tier rewards based on actual response speed. Faster nodes (Platinum) earn more than slow ones (Gold/Silver), implicitly filtering out lazy providers without brittle timing constants."
      },
      {
        q: "What is Unified Liveness?",
        a: "In most networks, 'serving a user' and 'proving you have data' are separate tasks. In NilStore, they are the same. When a user downloads a file, the receipt they sign acts as a cryptographic proof of storage. This eliminates wasted compute power and aligns incentives: the best way to earn storage rewards is to be a fast, reliable CDN."
      },
      {
        q: "Why 8 MiB Data Units?",
        a: "We use 8 MiB Mega-Data Units (MDUs) to optimize throughput. Larger units mean fewer on-chain transactions per Terabyte, allowing the network to scale to Petabytes without clogging the blockchain."
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
        q: "How do I earn $STOR?",
        a: <>
          You can join the network as a Storage Provider. You earn $STOR tokens in two ways:
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong>Capacity Rewards:</strong> For storing data and passing daily verification proofs.</li>
            <li><strong>Bandwidth Fees:</strong> For delivering data quickly to users.</li>
          </ul>
          Join our 'Store Wars' testnet to start earning today.
        </>
      },
      {
        q: "What happens if a node goes offline?",
        a: "We use Erasure Coding (like RAID for the internet). A file is split into many shards (e.g., 12). We only need a subset (e.g., 9) to recover the file. If a node disappears, the network detects it, slashes their collateral (burns their tokens), and automatically pays another node to reconstruct the missing shard."
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