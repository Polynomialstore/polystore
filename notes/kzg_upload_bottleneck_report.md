### Engineering Assessment: 512 GB Data Ingest Throughput

This report estimates the total "Time to Completion" for processing and uploading a **512 GB** dataset. It evaluates performance across two hardware environments (Disk-Limited vs. Network-Limited) and varying degrees of cryptographic parallelization.

#### **1. Cryptographic Assumptions & Overhead**
The primary throughput constraint for NilStore is the generation of KZG commitments. This assessment assumes the following cryptographic workload:

* **Algorithm:** KZG Commitments over the **BLS12-381** elliptic curve.
* **Operation:** Variable-Base Multi-Scalar Multiplication (MSM).
* **Work Unit:** One 128 KiB "Blob" requires an MSM of size 4,096.
* **Estimated Compute Cost (CPU):**
    * We assume a highly optimized implementation (e.g., Rust `blst` with **AVX-512** instructions).
    * **Per Blob Time:** ~15 milliseconds.
    * **Throughput per Core:** ~64 blobs/sec $\approx$ **8 MB/s**.
* **Estimated Compute Cost (GPU):**
    * We assume a CUDA-accelerated implementation (e.g., `Icicle`).
    * **Throughput:** **>1,400 MB/s** (Saturates PCIe bus or network first).

---

#### **2. Scenario A: Standard Server (Disk Limited)**
* **Environment:** Standard cloud instance (e.g., AWS EC2 General Purpose).
* **Constraint:** The disk read speed is physically capped at **250 MB/s**. Even if the network allows 1,250 MB/s, the drive cannot read data fast enough to fill the pipe.

| Configuration | Compute Throughput | Bottleneck | Effective Speed | Total Time (512 GB) |
| :--- | :--- | :--- | :--- | :--- |
| **0 Threads (S3 Baseline)** | *N/A (SHA-256 is >2GB/s)* | **Disk** | **250 MB/s** | **35 Minutes** |
| | | | | |
| **1 Thread** | 8 MB/s | Compute | 8 MB/s | **18.2 Hours** |
| **4 Threads** | 32 MB/s | Compute | 32 MB/s | **4.5 Hours** |
| **8 Threads** | 64 MB/s | Compute | 64 MB/s | **2.2 Hours** |
| **32 Threads** | 256 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| **64 Threads** | 512 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| **128 Threads** | 1,024 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |
| | | | | |
| **GPU Acceleration** | ~1,400 MB/s | **Disk** | **250 MB/s** | **35 Minutes** |

**Observation:** On standard hardware, CPU optimization hits a hard ceiling at **32 Threads**. Beyond this, the hard drive is the limiting factor.

---

#### **3. Scenario B: High-Performance Server (Network Limited)**
* **Environment:** Performance instance with NVMe SSDs (>2,000 MB/s Read).
* **Constraint:** The storage is no longer the bottleneck. The ceiling is the **10 Gbps (1,250 MB/s)** network uplink.

| Configuration | Compute Throughput | Bottleneck | Effective Speed | Total Time (512 GB) |
| :--- | :--- | :--- | :--- | :--- |
| **0 Threads (S3 Baseline)** | *N/A (SHA-256 is >2GB/s)* | **Network** | **1,250 MB/s** | **~7 Minutes** |
| | | | | |
| **1 Thread** | 8 MB/s | Compute | 8 MB/s | **18.2 Hours** |
| **4 Threads** | 32 MB/s | Compute | 32 MB/s | **4.5 Hours** |
| **8 Threads** | 64 MB/s | Compute | 64 MB/s | **2.2 Hours** |
| **32 Threads** | 256 MB/s | Compute | 256 MB/s | **34 Minutes** |
| **64 Threads** | 512 MB/s | Compute | 512 MB/s | **17 Minutes** |
| **128 Threads** | 1,024 MB/s | Compute | 1,024 MB/s | **8.5 Minutes** |
| | | | | |
| **GPU Acceleration** | ~1,400 MB/s | **Network** | **1,250 MB/s** | **~7 Minutes** |

**Observation:** In a high-performance environment, CPU-based KZG generation struggles to saturate the network. Even a massive 128-thread server lags slightly behind the S3 baseline. A single GPU is required and sufficient to match S3 performance (7 minutes) cost-effectively.

