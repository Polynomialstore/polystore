import { useAccount } from 'wagmi'
import { ethToNil } from '../lib/address'
import { useEffect, useState } from 'react'
import { Coins, RefreshCw, UploadCloud } from 'lucide-react'

interface Deal {
  id: string
  cid: string
  size: string
  owner: string
  escrow: string
  end_block: string
}

export function Dashboard() {
  const { address, isConnected } = useAccount()
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(false)
  const [faucetLoading, setFaucetLoading] = useState(false)
  const [nilAddress, setNilAddress] = useState('')

  useEffect(() => {
    if (address) {
      const cosmosAddress = ethToNil(address)
      setNilAddress(cosmosAddress)
      fetchDeals(cosmosAddress)
    } else {
        setDeals([])
    }
  }, [address])

  async function fetchDeals(owner: string) {
    setLoading(true)
    try {
        // Assuming default Cosmos REST port 1317
        // In production this should be an env var
        const response = await fetch('http://localhost:1317/nilchain/nilchain/v1/deals')
        const data = await response.json()
        if (data.deals) {
            // Filter client-side for now as discussed
            const myDeals = data.deals.filter((d: Deal) => d.owner === owner)
            setDeals(myDeals)
        }
    } catch (e) {
        console.error("Failed to fetch deals", e)
    } finally {
        setLoading(false)
    }
  }

  async function requestFunds() {
    if (!nilAddress) return
    setFaucetLoading(true)
    try {
        const response = await fetch('http://localhost:8081/faucet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: nilAddress })
        })
        if (!response.ok) throw new Error('Faucet failed')
        alert('Funds requested! Wait a few seconds for the transaction to confirm.')
    } catch (e) {
        alert('Failed to request funds. Is the faucet running?')
    } finally {
        setFaucetLoading(false)
    }
  }

  if (!isConnected) return (
    <div className="p-12 text-center">
        <h2 className="text-xl font-semibold text-gray-300 mb-2">Connect Your Wallet</h2>
        <p className="text-gray-500">Access your storage deals and manage your files.</p>
    </div>
  )

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto px-4 pt-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gray-900/30 p-6 rounded-xl border border-gray-800">
        <div>
            <h2 className="text-2xl font-bold text-white">My Storage Deals</h2>
            <p className="text-gray-400 text-sm mt-1">Manage your active file contracts</p>
        </div>
        <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
                <button 
                    onClick={() => alert("File upload via Web Interface coming in v0.2. Please use 'nil_cli upload' for now.")}
                    className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors shadow-lg shadow-indigo-500/20"
                >
                    <UploadCloud className="w-3 h-3" />
                    Upload File
                </button>
                <button 
                    onClick={requestFunds}
                    disabled={faucetLoading}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/20 rounded-md transition-colors disabled:opacity-50"
                >
                    {faucetLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
                    {faucetLoading ? 'Sending...' : 'Get Testnet NIL'}
                </button>
                <div className="text-right">
                    <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">Cosmos Identity</div>
                    <div className="font-mono text-indigo-400 bg-indigo-950/30 px-3 py-1 rounded text-sm border border-indigo-500/20">
                        {nilAddress}
                    </div>
                </div>
            </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mx-auto mb-4"></div>
            <p className="text-gray-500">Syncing with NilChain...</p>
        </div>
      ) : deals.length === 0 ? (
        <div className="bg-gray-900/50 rounded-xl p-16 text-center border border-gray-800 border-dashed">
            <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path></svg>
            </div>
            <h3 className="text-lg font-medium text-white mb-2">No active deals</h3>
            <p className="text-gray-400 mb-6 max-w-md mx-auto">You haven't stored any files on the NilNetwork yet. Upload a file to get started.</p>
            <button className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg font-medium transition-all">
                Upload New File
            </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900/50 shadow-xl">
            <table className="min-w-full divide-y divide-gray-800">
                <thead className="bg-gray-950/50">
                    <tr>
                        <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Deal ID</th>
                        <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Content Hash (CID)</th>
                        <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Size</th>
                        <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Escrow Balance</th>
                        <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                    {deals.map((deal) => (
                        <tr key={deal.id} className="hover:bg-white/5 transition-colors">
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">#{deal.id}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-indigo-400">{deal.cid.slice(0, 16)}...{deal.cid.slice(-6)}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB</td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{deal.escrow} NIL</td>
                            <td className="px-6 py-4 whitespace-nowrap">
                                <span className="px-2 py-1 text-xs rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                                    Active
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
      )}
    </div>
  )
}
