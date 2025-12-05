# NilStore Website & Explorer

The official frontend for the NilStore Network. This application serves as the marketing landing page, documentation hub, and interactive block explorer for the Incentivized Testnet ("Store Wars").

## Features

*   **Interactive Simulations:**
    *   **Security:** "The Bankruptcy Model" visualizes how the network economically punishes lazy providers.
    *   **Economy:** Agent-based simulation of token supply, inflation, and slashing events.
*   **Documentation:** Renders Markdown versions of the Whitepaper and Litepaper using `@tailwindcss/typography`.
*   **Lattice Map:** Visualizes real-time proof submissions on the local testnet.
*   **Deep Dives:** Interactive explanations of Sharding, KZG Commitments, and the Performance Market.

## Tech Stack

*   **Framework:** React (Vite)
*   **Language:** TypeScript
*   **Styling:** Tailwind CSS
*   **Animations:** Framer Motion
*   **Icons:** Lucide React

## Development

### Setup
```bash
npm install
```

### Run Locally
```bash
npm run dev
```
The site will launch at `http://localhost:5173`.

### Build for Production
```bash
npm run build
```
Output is generated in the `dist/` directory.

## Deployment

This project is configured for **Netlify** via `netlify.toml`.
*   **Build Command:** `npm run build`
*   **Publish Directory:** `dist`