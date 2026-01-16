import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { WalletConnectModal } from "@walletconnect/modal";
import { useCallback, useEffect, useMemo, useState } from "react";

const DEFAULT_CHAIN_ID = 31337;
const PROJECT_ID =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ??
  "00000000000000000000000000000000";

const metadata = {
  name: "NilGateway GUI",
  description: "NilStore desktop gateway",
  url: "https://nil.store",
  icons: [],
};

const modal = new WalletConnectModal({
  projectId: PROJECT_ID,
});

type WalletStatus = "disconnected" | "connecting" | "connected";

function parseAccount(account: string) {
  const [namespace, chainId, address] = account.split(":");
  if (!namespace || !chainId || !address) {
    return { chainId: DEFAULT_CHAIN_ID, address: account };
  }
  return { chainId: Number(chainId), address };
}

export function useWallet() {
  const [client, setClient] = useState<SignClient | null>(null);
  const [session, setSession] = useState<SessionTypes.Struct | null>(null);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    SignClient.init({ projectId: PROJECT_ID, metadata })
      .then((instance) => setClient(instance))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!client) {
      return;
    }

    const handler = () => {
      setSession(null);
      setStatus("disconnected");
      setAddress(null);
    };
    client.on("session_delete", handler);
    return () => {
      client.off("session_delete", handler);
    };
  }, [client]);

  const connect = useCallback(async () => {
    if (!client) {
      setError("WalletConnect not initialized");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const { uri, approval } = await client.connect({
        requiredNamespaces: {
          eip155: {
            methods: ["eth_signTypedData_v4", "eth_accounts", "eth_chainId"],
            chains: [`eip155:${chainId}`],
            events: ["accountsChanged", "chainChanged"],
          },
        },
      });

      if (uri) {
        modal.openModal({ uri });
      }
      const nextSession = await approval();
      modal.closeModal();

      setSession(nextSession);
      setStatus("connected");
      const accounts = nextSession.namespaces.eip155?.accounts ?? [];
      if (accounts.length > 0) {
        const parsed = parseAccount(accounts[0]);
        setAddress(parsed.address);
        setChainId(parsed.chainId || DEFAULT_CHAIN_ID);
      }
    } catch (err) {
      modal.closeModal();
      setStatus("disconnected");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, chainId]);

  const disconnect = useCallback(async () => {
    if (!client || !session) {
      return;
    }
    await client.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: "User disconnected" },
    });
    setSession(null);
    setStatus("disconnected");
    setAddress(null);
  }, [client, session]);

  const signTypedData = useCallback(
    async (typedData: unknown) => {
      if (!client || !session || !address) {
        throw new Error("Wallet not connected");
      }
      const result = await client.request({
        topic: session.topic,
        chainId: `eip155:${chainId}`,
        request: {
          method: "eth_signTypedData_v4",
          params: [address, JSON.stringify(typedData)],
        },
      });
      return String(result);
    },
    [client, session, address, chainId],
  );

  return useMemo(
    () => ({
      status,
      address,
      chainId,
      error,
      connect,
      disconnect,
      signTypedData,
    }),
    [status, address, chainId, error, connect, disconnect, signTypedData],
  );
}
