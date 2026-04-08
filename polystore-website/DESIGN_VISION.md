# POLYSTORE DESIGN MANIFESTO: THE CYBER-INDUSTRIAL COMMAND CENTER

## I. THE CORE VISION
NilStore is not a "cloud" service; it is a **Permanent Storage Protocol**. The interface must reject the ephemeral, soft, and "webby" trends of modern SaaS. Instead, it must embody the weight, reliability, and precision of industrial hardware and tactical military equipment.

The design language of NilStore is **Cyber-Industrial**. It is the intersection of a high-fidelity engineering blueprint and a high-end tactical HUD.

---

## II. THE TWO OPERATING ENVIRONMENTS

### 1. Mode A: The Engineering Blueprint (Light Mode)
*   **Concept:** A digital engineering blueprint. A high-precision workspace that emphasizes clarity and technical accuracy, utilizing vibrant neon accents to define protocol structure.
*   **Palette:** Pure White "Canvas" background, Deep Charcoal "Ink" text, and **"Neon Pale Fuschia"** structural highlights.
*   **Feeling:** Analytical, high-energy, and modern. It is the "daylight" environment for deep data analysis, where electric accents guide the eye through the protocol's geometry.

### 2. Mode B: The Tactical Console (Dark Mode)
*   **Concept:** A solid physical console in a darkened command center.
*   **Palette:** Deep Charcoal "Slabs" floating in a pure black void.
*   **Lighting:** Objects are defined by **Emissive Rim Lighting** (top-edge highlights) and **Cyber Cyan Glows** (glowing data) rather than shadows.
*   **Feeling:** Focused, heavy, immersive, and "Always-On." It is the environment for mission-critical monitoring.

---

## III. THE FOUR PILLARS OF DESIGN

### 1. Physicality & Solidity
*   **The Slab Principle:** Every UI element is a physical "module." It must be **100% opaque** (or nearly opaque at 98% in Dark Mode). 
*   **No Grid-Bleed:** Background patterns must never cut through functional data. If a panel is on the screen, it is a solid object that occludes the floor.
*   **Weight:** Use minimal, tight shadows (1-4px) in Light Mode to maintain a "Cleanroom" aesthetic. In Dark Mode, rely on rim-lighting and solid borders to ground modules, avoiding soft black blurs.

### 2. Absolute Geometry
*   **The 90-Degree Mandate:** There are **zero** rounded corners in the NilStore universe. Every edge is sharp, precise, and industrial.
*   **Hierarchy via Thickness:** Distinguish between primary containers and secondary dividers using border-weight (1px vs 2px) rather than color shifts.

### 3. Tactical Typography
*   **Headers (Montserrat):** Bold, geometric, and authoritative. Used for system paths and high-level navigation.
*   **Data (JetBrains Mono):** The "Pulse" of the protocol. CIDs, hashes, and addresses must look like they are being emitted from a technical terminal. 
*   **Pathing:** Use system-style headers (e.g., `/WAL/ACCOUNT`) to reinforce the idea that the user is navigating a file-system or protocol, not just a website.

### 4. Technical Detail (The HUD)
*   **L-Brackets:** Corners are anchored by 1px "L-brackets" rather than solid dots. In Light Mode, these utilize **Neon Pale Fuschia** to provide high-visibility framing for opaque modules. These are HUD "targeters" that cradle the data.
*   **Scanning Elements:** Use a slow, broad "Technical Wash" (20s cycle) across the background grid to indicate that the protocol is alive and actively processing data.
*   **Safety Accents:** Use the active **Primary** lane for actions, a secondary **Accent** lane for alternate emphasis, and **Signal Green** (`success`) for healthy/valid/success states. These colors must have high luminance to pop against the neutral base.

---

## IV. NON-NEGOTIABLES (THE "NEVER" LIST)
1.  **NEVER** use rounded corners (`rounded-lg`, `rounded-full`).
2.  **NEVER** allow the background grid to be visible through a card or menu (Maintain the Slab Principle).
3.  **NEVER** use standard "drop shadows" in Dark Mode; use top-edge rim lighting instead.
4.  **NEVER** use conversational or "friendly" copy. Use technical, direct, and system-oriented labels.
5.  **NEVER** use more than three primary colors for UI components. Brand assets, logos, and specialized status iconography may utilize the extended "Signal" palette (including Signal Green and Protocol Purple) to distinguish between data types.

---

## V. THE DESIGN GOAL
When a user opens NilStore, they should feel like they have just stepped into a high-security server room or a tactical operations center. The UI is a **tool**, not a toy. It is built for the long-term, for reliability, and for the permanent storage of human knowledge.
