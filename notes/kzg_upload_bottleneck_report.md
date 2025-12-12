### Engineering Assessment: 512 GB Data Ingest Throughput
**Revised for Network-Bound Traffic**

This report estimates the total "Time to Completion" for processing and uploading a **512 GB** dataset. It evaluates performance across two hardware environments:
1.  **Standard Storage (Disk Limited):** Typical general-purpose cloud storage (e.g., AWS gp3).
2.  **High-Performance (Network Limited):** High-throughput storage (e.g., NVMe) where the 10 Gbps uplink is the only ceiling.

#### **1. Basis of Estimate**
These constants define the theoretical speed limits for the calculations below.

* **Total Payload:** 512 GiB (524,288 MiB).
* **Network Bandwidth:** **1,250 MB/s** (10 Gbps Uplink).
* **Compute Unit (KZG):** **8 MB/s per Thread**.
    * *Derived from:* Optimized Rust/Assembly (`blst`) implementation on a modern AVX-512 CPU core (~15s per 1GB on 8 cores).
* **GPU Throughput:** **~1,400 MB/s**.
    * *Derived from:* CUDA-accelerated MSM (e.g., `Icicle`) on a standard Data Center GPU (NVIDIA A10 or similar).

---

#### **2. Scenario A: Standard Server (Disk Limited)**
*Constraint:* The disk read speed is capped at **250 MB/s**. The network (1,250 MB/s) is never fully utilized because the disk cannot feed it fast enough.

| Configuration | Compute Throughput | Bottleneck | Effective Speed | Total Time (512 GB) |
| :--- | :--- | :--- | :--- | :--- |
| **0 Threads (S3 Baseline)** | *N/A* | **Disk** | **250 MB/s** | **35 Minutes** |
| | | | | |
| **1 Thread** | 8 MB/s | Compute | 8 MB/s | **18.2 Hours** |
| **4 Threads** | 32 MB/s | Compute | 32 MB/s | **4.5 Hours** |
| **8 Threads** | 64 MB/s | Compute | 64 MB/s | **2.2 Hours** |
| **32 Threads** | 256 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| **64 Threads** | 512 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| **128 Threads** | 1,024 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| | | | | |
| **GPU Acceleration** | ~1,400 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |

---

#### **3. Scenario B: High-Performance Server (Network Limited)**
*Constraint:* The server uses fast NVMe storage (>2,000 MB/s). The disk is no longer the bottleneck; the ceiling is now the **1,250 MB/s** network uplink.

| Configuration | Compute Throughput | Bottleneck | Effective Speed | Total Time (512 GB) |
| :--- | :--- | :--- | :--- | :--- |
| **0 Threads (S3 Baseline)** | *N/A* | **Network** | **1,250 MB/s** | **~7 Minutes** |
| | | | | |
| **1 Thread** | 8 MB/s | Compute | 8 MB/s | **18.2 Hours** |
| **4 Threads** | 32 MB/s | Compute | 32 MB/s | **4.5 Hours** |
| **8 Threads** | 64 MB/s | Compute | 64 MB/s | **2.2 Hours** |
| **32 Threads** | 256 MB/s | Compute | 256 MB/s | **34 Minutes** |
| **64 Threads** | 512 MB/s | Compute | 512 MB/s | **17 Minutes** |
| **128 Threads** | 1,024 MB/s | Compute | 1,024 MB/s | **8.5 Minutes** |
| | | | | |
| **GPU Acceleration** | ~1,400 MB/s | **Network** | **1,250 MB/s** | **~7 Minutes** |

---

#### **4. Engineering Conclusions**

1.  **The "Parity Point" Shifts Dramatically:**
    * On a **Standard Disk**, you only need **~32 Threads** (a typical dual-socket server) to match S3 performance.
    * On a **Fast Network/Disk**, CPU parity is nearly impossible. Even with **128 Threads** (a massive 128-core EPYC/Ampere server), you still lag slightly behind the raw network speed (8.5 mins vs 7 mins).

2.  **GPU is Mandatory for 10Gbps Saturation:**
    * In the high-performance scenario, the only way to saturate a 10 Gbps uplink without buying an expensive 128-core server is to add a single GPU. The GPU allows a modest CPU to achieve the maximum theoretical network throughput.

3.  **Diminishing Returns (Disk vs. CPU):**
    * Notice that in Scenario A (Standard Disk), adding threads beyond 32 yields **zero benefit**. The math gets faster, but the hard drive effectively throttles the entire operation.
