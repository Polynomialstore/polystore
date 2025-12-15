/* eslint-disable react-refresh/only-export-components */import { createContext, useContext, useState, ReactNode } from "react";

interface TechnologyContextType {
  highlightedPath: string | null;
  setHighlightedPath: (path: string | null) => void;
}

const TechnologyContext = createContext<TechnologyContextType | undefined>(undefined);

export const TechnologyProvider = ({ children }: { children: ReactNode }) => {
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);

  return (
    <TechnologyContext.Provider value={{ highlightedPath, setHighlightedPath }}>
      {children}
    </TechnologyContext.Provider>
  );
};

export const useTechnology = () => {
  const context = useContext(TechnologyContext);
  if (!context) {
    throw new Error("useTechnology must be used within a TechnologyProvider");
  }
  return context;
};
