const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8081'
const LCD_BASE = import.meta.env.VITE_LCD_BASE || 'http://localhost:1317'
const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE || 'http://localhost:8080'
const SP_BASE = import.meta.env.VITE_SP_BASE || 'http://localhost:8082'
const COSMOS_CHAIN_ID = import.meta.env.VITE_COSMOS_CHAIN_ID || '31337'
const BRIDGE_ADDRESS = import.meta.env.VITE_BRIDGE_ADDRESS || '0x0000000000000000000000000000000000000000'
const NILSTORE_PRECOMPILE =
  import.meta.env.VITE_NILSTORE_PRECOMPILE || '0x0000000000000000000000000000000000000900'

export const appConfig = {
  apiBase: API_BASE.replace(/\/$/, ''),
  lcdBase: LCD_BASE.replace(/\/$/, ''),
  evmRpc: import.meta.env.VITE_EVM_RPC || 'http://localhost:8545',
  chainId: Number(import.meta.env.VITE_CHAIN_ID || 31337),
  gatewayBase: GATEWAY_BASE.replace(/\/$/, ''),
  spBase: SP_BASE.replace(/\/$/, ''),
  cosmosChainId: COSMOS_CHAIN_ID,
  bridgeAddress: BRIDGE_ADDRESS,
  nilstorePrecompile: NILSTORE_PRECOMPILE.trim(),
}
