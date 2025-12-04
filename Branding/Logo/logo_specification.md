# NilStore Logo: Visual Identity & Technical Specification

**Document Version:** 1.1  
**Date:** 2025-12-04  
**Status:** Final Reference

---

## 1. Overview

The NilStore logo is a visual synthesis of the network's core philosophy: **"Structured Infinity."** It combines rigid, higher-dimensional geometry (the Tesseract/Hypercube) with fluid, self-healing topology (the Möbius Lattice). This document serves as the source of truth for reproducing, analyzing, or briefing designers on the brand mark.

## 2. Typography

Based on forensic analysis of the wordmark associated with the logo:

*   **Primary Font:** **Gotham Bold** (or Gotham Medium).
*   **Characteristics:**
    *   Geometric Sans-Serif structure (wide circular "O" and "C").
    *   Signature "R" leg extending straight down at an angle.
    *   Horizontal terminals on the "S".
    *   Monoline stroke width.
*   **Open Source Alternative:** **Montserrat Bold** (Google Fonts) is the recommended free substitute for web and open-source materials.

## 3. Visual Analysis (Brand Guidelines)

This section defines the aesthetic properties for brand consistency.

### A. Geometry & Structure
*   **The Frame (Container):** A neon wireframe depicting a **Tesseract** (hypercube) projection. It represents the rigid, immutable structure of the ledger and the consensus layer. It is defined by sharp $90^\circ$ vertices and straight, glowing lines.
*   **The Ribbon (Flow):** Intertwined with the frame is a continuous tubular structure forming a distorted **Torus Knot** or Möbius loop. It represents the fluid data layer (NilFS) and the self-healing "Ricci Flow" of the network.
*   **Interaction:** The ribbon weaves *through* the rigid faces of the cube, symbolizing the seamless movement of data across the immutable lattice.

### B. Texture & Pattern
*   **Lattice Mesh:** The ribbon is constructed from a **Hexagonal Lattice** (honeycomb mesh). This texture represents the sharded "Data Units" (DUs) and the peer-to-peer nature of the network.
*   **Deformation:** The hexagonal pattern warps along the curvature of the tube—compressing at bends and stretching on straights—enhancing the 3D volumetric illusion.

### C. Color Palette (Cyber-Topological)
The palette is high-contrast "Synthwave" set against a deep void.

*   **Electric Cyan (`#00E5FF`):** Used for the Cube Frame and the "NIL" portion of the text. Represents energy, precision, and the L1 chain.
*   **Neon Violet (`#E056FD`):** Used for the Ribbon Mesh and the "STORE" portion of the text. Represents depth, complex data, and the L2 settlement layer.
*   **Deep Indigo (`#7B2CBF`):** Used for shadows and gradients within the mesh to provide volume.

### D. Lighting & Effects
*   **Luminescence:** The defining trait is **Emissivity**. The logo does not reflect light; it emits it. A "Bloom" or Gaussian blur effect surrounds all lines, simulating laser projection or cathode-ray glow.
*   **Translucency:** The ribbon is semi-transparent; the background is visible through the gaps in the hexagonal mesh, keeping the logo feeling lightweight and "airy."

---

## 4. Asset Usage Guide

### Theme Compatibility
NilStore uses a theme-aware logo strategy to ensure visibility across different environments.

*   **Standard Logo (`logo_light.jpg`):**
    *   **Description:** The original "Neon on Black" rendering.
    *   **Usage:** **Dark Mode** interfaces, headers with dark backgrounds, presentation slides with black backgrounds.
    *   **Visuals:** Bright Cyan/Violet lines glowing against a deep black void.

*   **Inverted Logo (`logo_dark.jpg`):**
    *   **Description:** A "High Contrast" version optimized for light backgrounds.
    *   **Usage:** **Light Mode** interfaces, white papers, printed documents on white paper.
    *   **Visuals:** Dark/Deep lines on a white/light background (simulating ink on paper or a technical drawing).

*   **Favicon (`favicon.ico`):**
    *   **Usage:** Browser tabs. Derived from the high-contrast (dark line) version for maximum visibility at small scales.

---

## 5. Technical Design Specification (For 3D Reconstruction)

This specification is intended for 3D artists (Blender/C4D) to reconstruct the asset accurately.

### I. Structural Geometry (The Frame)
*   **Shape:** Standard Cube wireframe (12 edges).
*   **Projection:** Isometric view (~35.264° X-axis rotation, 45° Y-axis rotation).
*   **Stroke:** Continuous, solid cylindrical strokes with constant radius.
*   **Vertices:** Sharp $90^\circ$ corners with minimal beveling for specular highlights.

### II. The Internal Manifold (The Ribbon)
*   **Topology:** Closed-loop manifold (distorted Torus).
*   **Trajectory:** Functions as a "strange attractor," entering the cubic volume, twisting around the front-left vertical edge, and diving inside. Non-intersecting.
*   **Surface:** Wireframe shell derived from a Hexagonal Grid (Honeycomb).
*   **Scale:** High density; approx 3-4 hexagonal cells visible across the ribbon's diameter.
*   **UV Mapping:** Anisotropic. Hexagons stretch horizontally on convex curves and compress on concave curves.

### III. Material & Shader
*   **Shading Model:** Unlit / Self-Illuminated.
*   **Fresnel Effect:**
    *   **Cube:** Uniform Cyan (`#00E5FF`) with White (`#E0FFFF`) core intensity.
    *   **Ribbon:** Violet (`#7B2CBF`) base with bright Neon Magenta (`#E056FD`) rim lighting on glancing angles.
*   **Alpha:**
    *   Cube Lines: 100% Opacity.
    *   Ribbon Wire: 100% Opacity.
    *   Ribbon Voids: 0% Opacity (Transparent).

### IV. Scene & Composition
*   **Background:** Pitch Black (`#000000`).
*   **Floor:** Faint, deep blue grid (`#001133`) on the X-Z plane, fading linearly into darkness.
*   **Balance:** Asymmetrical balance. The symmetry of the cube is broken by the organic twist of the ribbon, creating dynamic tension centered in the frame.