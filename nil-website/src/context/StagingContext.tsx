// nil-website/src/context/StagingContext.tsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface StagedFile {
  key: string; // Composite key: dealId + '::' + path
  path: string; // Relative path in the deal
  size: number;
  lastModified: number;
  dealId: string;
  status: 'staged' | 'syncing' | 'synced' | 'error';
  error?: string;
}

interface StagingDB extends DBSchema {
  files: {
    key: string; // Composite key: dealId + '::' + path
    value: StagedFile;
    indexes: { 'by-deal': string };
  };
}

interface StagingContextType {
  stagedFiles: StagedFile[];
  addStagedFile: (dealId: string, file: File, path?: string) => Promise<void>;
  updateFileStatus: (dealId: string, path: string, status: StagedFile['status'], error?: string) => Promise<void>;
  removeStagedFile: (dealId: string, path: string) => Promise<void>;
  getFilesForDeal: (dealId: string) => StagedFile[];
}

const StagingContext = createContext<StagingContextType | undefined>(undefined);

const DB_NAME = 'nilstore-staging';
const DB_VERSION = 1;

export function StagingProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<IDBPDatabase<StagingDB> | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);

  // Initialize DB
  useEffect(() => {
    async function initDB() {
      const database = await openDB<StagingDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          const store = db.createObjectStore('files', { keyPath: 'key' });
          store.createIndex('by-deal', 'dealId');
        },
      });
      setDb(database);
      const allFiles = await database.getAll('files');
      setStagedFiles(allFiles);
    }
    initDB();
  }, []);

  const addStagedFile = useCallback(async (dealId: string, file: File, path?: string) => {
    if (!db) return;
    
    const filePath = path || file.name;
    const key = `${dealId}::${filePath}`;
    
    const stagedFile: StagedFile = {
      key,
      path: filePath,
      size: file.size,
      lastModified: file.lastModified,
      dealId,
      status: 'staged',
    };

    await db.put('files', stagedFile);
    setStagedFiles(prev => {
        const filtered = prev.filter(f => f.dealId !== dealId || f.path !== filePath);
        return [...filtered, stagedFile];
    });
  }, [db]);

  const updateFileStatus = useCallback(async (dealId: string, path: string, status: StagedFile['status'], error?: string) => {
    if (!db) return;
    const key = `${dealId}::${path}`;
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    
    const record = await store.get(key);
    if (!record) return; // Should we throw?

    const updated = { ...record, status, error };
    await store.put({ ...updated, key });
    await tx.done;

    setStagedFiles(prev => prev.map(f => (f.dealId === dealId && f.path === path) ? updated : f));
  }, [db]);

  const removeStagedFile = useCallback(async (dealId: string, path: string) => {
    if (!db) return;
    const key = `${dealId}::${path}`;
    await db.delete('files', key);
    setStagedFiles(prev => prev.filter(f => !(f.dealId === dealId && f.path === path)));
  }, [db]);

  const getFilesForDeal = useCallback((dealId: string) => {
    return stagedFiles.filter(f => f.dealId === dealId);
  }, [stagedFiles]);

  return (
    <StagingContext.Provider value={{ stagedFiles, addStagedFile, updateFileStatus, removeStagedFile, getFilesForDeal }}>
      {children}
    </StagingContext.Provider>
  );
}

export function useStaging() {
  const context = useContext(StagingContext);
  if (context === undefined) {
    throw new Error('useStaging must be used within a StagingProvider');
  }
  return context;
}
