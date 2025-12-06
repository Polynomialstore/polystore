const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8081'
const LCD_BASE = import.meta.env.VITE_LCD_BASE || 'http://localhost:1317'
const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE || 'http://localhost:8080'

export const appConfig = {
  apiBase: API_BASE.replace(/\/$/, ''),
  lcdBase: LCD_BASE.replace(/\/$/, ''),
  evmRpc: import.meta.env.VITE_EVM_RPC || 'http://localhost:8545',
  chainId: Number(import.meta.env.VITE_CHAIN_ID || 262144),
  gatewayBase: GATEWAY_BASE.replace(/\/$/, ''),
}
