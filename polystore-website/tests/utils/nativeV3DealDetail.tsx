/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAccount, useConnect } from 'wagmi'

import { lcdFetchDeal } from '../../src/api/lcdClient'
import { DealDetail } from '../../src/components/DealDetail'
import { appConfig } from '../../src/config'
import { Web3Provider } from '../../src/context/Web3Provider'
import { TransportProvider } from '../../src/context/TransportContext'
import type { LcdDeal } from '../../src/domain/lcd'
import { useLocalGateway } from '../../src/hooks/useLocalGateway'
import { ethToPolystoreAddress } from '../../src/lib/address'

type MountedDealDetail = { element: HTMLElement; unmount: () => void }

function LiveDeal({ deal, payer }: { deal: LcdDeal; payer: string }) {
  const gateway = useLocalGateway(1000)
  const { address, isConnected } = useAccount()
  const { connectors, connectAsync } = useConnect()
  const connecting = useRef(false)

  useEffect(() => {
    if (isConnected || connecting.current || connectors.length === 0) return
    connecting.current = true
    void connectAsync({ connector: connectors[0] }).finally(() => { connecting.current = false })
  }, [connectAsync, connectors, isConnected])

  const connectedPayer = address ? ethToPolystoreAddress(address) : ''
  const ready = isConnected && connectedPayer === payer && gateway.status === 'connected'
  return (
    <main data-testid="native-v3-live-driver" data-ready={ready ? 'true' : 'false'}
      data-gateway-status={gateway.status} data-gateway-url={gateway.url}>
      {ready ? <DealDetail deal={deal} polystoreAddress={payer} /> : null}
    </main>
  )
}

export async function mountNativeV3DealDetail(dealId: string, payer: string): Promise<MountedDealDetail> {
  const deal = await lcdFetchDeal(appConfig.lcdBase, dealId)
  if (!deal || String(deal.id) !== String(dealId)) throw new Error(`missing native V3 deal ${dealId}`)
  const element = document.createElement('div')
  element.id = 'native-v3-live-root'
  document.body.append(element)
  const root: Root = createRoot(element)
  root.render(
    <Web3Provider>
      <TransportProvider>
        <LiveDeal deal={deal} payer={payer} />
      </TransportProvider>
    </Web3Provider>,
  )
  return { element, unmount: () => { root.unmount(); element.remove() } }
}
