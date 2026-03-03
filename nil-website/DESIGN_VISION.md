# NILSTORE DESIGN MANIFESTO: THE CYBER-INDUSTRIAL COMMAND CENTER

## I. THE CORE VISION
NilStore is not a "cloud" service; it is a **Permanent Storage Protocol**. The interface must reject the ephemeral, soft, and "webby" trends of modern SaaS. Instead, it must embody the weight, reliability, and precision of industrial hardware and tactical military equipment.

The design language of NilStore is **Cyber-Industrial**. It is the intersection of a safety-compliant factory floor and a high-end tactical HUD.

---

## II. THE TWO OPERATING ENVIRONMENTS

### 1. Mode A: The Engineering Blueprint (Light Mode)
*   **Concept:** A high-contrast technical drawing printed on heavy-stock drafting paper.
*   **Palette:** Off-white "Paper" background, Deep Navy "Ink" text, and "Safety Orange" highlights.
*   **Feeling:** Analytical, clean, professional, and high-energy. It is the "daylight" environment for deep data analysis.

### 2. Mode B: The Tactical Console (Dark Mode)
*   **Concept:** A solid physical console in a darkened command center.
*   **Palette:** Deep Charcoal "Slabs" floating in a pure black void.
*   **Lighting:** Objects are defined by **Rim Lighting** (top-edge highlights) and **Emissive Glows** (glowing data) rather than shadows.
*   **Feeling:** Focused, heavy, immersive, and "Always-On." It is the environment for mission-critical monitoring.

---

## III. THE FOUR PILLARS OF DESIGN

### 1. Physicality & Solidity
*   **The Slab Principle:** Every UI element is a physical "module." It must be **100% opaque**. 
*   **No Grid-Bleed:** Background patterns must never cut through functional data. If a panel is on the screen, it is a solid object that occludes the floor.
*   **Weight:** Use large-spread ambient occlusion (soft black blurs) to ground modules in space, making them feel like they have mass.

### 2. Absolute Geometry
*   **The 90-Degree Mandate:** There are **zero** rounded corners in the NilStore universe. Every edge is sharp, precise, and industrial.
*   **Hierarchy via Thickness:** Distinguish between primary containers and secondary dividers using border-weight (1px vs 2px) rather than color shifts.

### 3. Tactical Typography
*   **Headers (Montserrat):** Bold, geometric, and authoritative. Used for system paths and high-level navigation.
*   **Data (JetBrains Mono):** The "Pulse" of the protocol. CIDs, hashes, and addresses must look like they are being emitted from a technical terminal. 
*   **Pathing:** Use system-style headers (e.g., `/WAL/ACCOUNT`) to reinforce the idea that the user is navigating a file-system or protocol, not just a website.

### 4. Technical Detail (The HUD)
*   **L-Brackets:** Corners are anchored by 1px "L-brackets" rather than solid dots. These are HUD "targeters" that cradle the data.
*   **Scanning Elements:** Use subtle motion (scan lines, pulsing status dots) to indicate that the protocol is alive and actively processing data.
*   **Safety Accents:** Use "Safety Orange" (Primary) for actions and "Signal Green" (Accent) for success. These colors must have high luminance to pop against the neutral base.

---

## IV. NON-NEGOTIABLES (THE "NEVER" LIST)
1.  **NEVER** use rounded corners (`rounded-lg`, `rounded-full`).
2.  **NEVER** allow the background grid to be visible through a card or menu.
3.  **NEVER** use standard "drop shadows" in Dark Mode; use top-edge rim lighting instead.
4.  **NEVER** use conversational or "friendly" copy. Use technical, direct, and system-oriented labels.
5.  **NEVER** use more than three primary colors. The beauty of NilStore is its restrained, technical palette.

---

## V. THE DESIGN GOAL
When a user opens NilStore, they should feel like they have just stepped into a high-security server room or a tactical operations center. The UI is a **tool**, not a toy. It is built for the long-term, for reliability, and for the permanent storage of human knowledge.
