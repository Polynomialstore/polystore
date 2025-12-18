import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/montserrat/700.css'
import '@fontsource/montserrat/800.css'
import App from './App.tsx'
import './index.css'
import { Web3Provider } from './context/Web3Provider.tsx'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Web3Provider>
      <App />
    </Web3Provider>
  </React.StrictMode>,
)
