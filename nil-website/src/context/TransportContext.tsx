import React, { createContext, useContext, useMemo, useState } from 'react'
import { appConfig } from '../config'
import type { DecisionTrace, RoutePreference } from '../lib/transport/types'

interface TransportContextType {
  preference: RoutePreference
  setPreference: (pref: RoutePreference) => void
  lastTrace: DecisionTrace | null
  setLastTrace: (trace: DecisionTrace | null) => void
}

const TransportContext = createContext<TransportContextType | undefined>(undefined)

const PREF_KEY = 'nil_transport_preference'

function getInitialPreference(): RoutePreference {
  if (typeof window === 'undefined') return 'auto'
  if (appConfig.gatewayDisabled) return 'prefer_direct_sp'
  const raw = window.localStorage.getItem(PREF_KEY)
  if (raw === 'prefer_p2p') return appConfig.p2pEnabled ? raw : 'auto'
  if (raw === 'prefer_gateway' || raw === 'prefer_direct_sp' || raw === 'auto') return raw
  return 'auto'
}

export function TransportProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<RoutePreference>(getInitialPreference)
  const [lastTrace, setLastTrace] = useState<DecisionTrace | null>(null)

  const setPreference = (pref: RoutePreference) => {
    setPreferenceState(pref)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREF_KEY, pref)
    }
  }

  const value = useMemo(
    () => ({
      preference,
      setPreference,
      lastTrace,
      setLastTrace,
    }),
    [preference, lastTrace],
  )

  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTransportContext(): TransportContextType {
  const ctx = useContext(TransportContext)
  if (!ctx) throw new Error('useTransportContext must be used within TransportProvider')
  return ctx
}
