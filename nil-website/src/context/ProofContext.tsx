/* eslint-disable react-refresh/only-export-components */import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

interface Proof {
  id: string;
  creator: string;
  commitment: string;
  block_height: string;
  source?: 'chain' | 'simulated';
}

interface ProofContextType {
  proofs: Proof[];
  addSimulatedProof: (proof: Proof) => void;
  loading: boolean;
}

const ProofContext = createContext<ProofContextType | undefined>(undefined);

export const ProofProvider = ({ children }: { children: ReactNode }) => {
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch real proofs from chain
  useEffect(() => {
    const API_URL = "http://localhost:1317/nilchain/nilchain/v1/proofs";
    fetch(API_URL)
      .then(res => res.json())
      .then(data => {
        if (data.proof) {
            setProofs(prev => {
                // Merge chain proofs, avoiding duplicates by ID
                const existingIds = new Set(prev.map(p => p.id));
                const newProofs = data.proof.filter((p: Proof) => !existingIds.has(p.id));
                return [...prev, ...newProofs.map((p: Proof) => ({...p, source: 'chain' as const}))];
            });
        }
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch proofs", err);
        setLoading(false);
      });
  }, []);

  const addSimulatedProof = (proof: Proof) => {
    setProofs(prev => [{ ...proof, source: 'simulated' }, ...prev]);
  };

  return (
    <ProofContext.Provider value={{ proofs, addSimulatedProof, loading }}>
      {children}
    </ProofContext.Provider>
  );
};

export const useProofs = () => {
  const context = useContext(ProofContext);
  if (!context) {
    throw new Error('useProofs must be used within a ProofProvider');
  }
  return context;
};
