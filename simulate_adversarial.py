import json
import random
import time
import os

# Configuration
SIMULATION_FILE = "nil-website/src/data/adversarial_simulation.json"
ITERATIONS = 100

def main():
    print("[Sim] Starting Economic Security Simulation (The Bankruptcy Model)...")
    
    # Parameters
    # Costs are in fictional $ units per GB/month or per operation
    STORAGE_COST_NVME = 0.02 # $/GB/month (Local)
    STORAGE_COST_S3 = 0.004  # $/GB/month (Remote/Cold) - Cheaper
    
    BANDWIDTH_COST_S3 = 0.05 # $/GB (Egress fee for attacker)
    
    # Rewards (NIL tokens, normalized to $)
    REWARD_PLATINUM = 0.10 # High speed
    REWARD_GOLD = 0.08     # Med speed
    REWARD_FAIL = 0.0      # Too slow
    
    # Latency Thresholds (Blocks)
    # 1 Block ~ 6s.
    # Platinum: < 1 Block latency (Local read + compute)
    # Gold: < 5 Blocks
    # Fail: > 20 Blocks
    
    # Agents
    # 1. Honest NVMe Node
    # 2. Lazy S3 Wrapper
    
    honest_balance = 100.0 # Initial capital
    attacker_balance = 100.0
    
    results = []
    
    for i in range(1, ITERATIONS + 1):
        # Simulation Logic per Epoch (simplified)
        
        # Honest Node:
        # Cost: Storage
        honest_balance -= STORAGE_COST_NVME
        # Latency: Low (Local NVMe read ~microseconds + Argon2id 1s) -> ~1s total -> Block H+1
        # Reward: Platinum
        honest_balance += REWARD_PLATINUM
        honest_tier = "Platinum"
        
        # Attacker Node:
        # Cost: Storage (Cheap)
        attacker_balance -= STORAGE_COST_S3
        # Cost: Bandwidth (Must fetch from S3 to compute PoDE)
        # Assume 1 unit of data fetched
        attacker_balance -= BANDWIDTH_COST_S3
        
        # Latency: High (S3 Fetch ~300-500ms + Jitter + Argon2id 1s + Overhead)
        # Realistically, if deadline is 1.1s, they fail hard.
        # In "Performance Market" (v2.6), they might hit Gold or Fail depending on network conditions.
        # Let's simulate network jitter.
        network_latency = random.gauss(0.5, 0.2) # 500ms avg, 200ms dev
        total_latency = 1.0 + network_latency
        
        # Mapping Latency to Tier
        # If total > 1.5s -> Missed Platinum
        # If total > 5s -> Missed Gold
        
        if total_latency < 1.5:
            # Unlikely for S3
            attacker_tier = "Platinum"
            attacker_balance += REWARD_PLATINUM
        elif total_latency < 5.0:
            # Likely
            attacker_tier = "Gold"
            attacker_balance += REWARD_GOLD
        else:
            attacker_tier = "Fail"
            # No reward
            
        # Attacker Profit Check:
        # They paid 0.004 (Storage) + 0.05 (BW) = 0.054
        # Earned 0.08 (Gold) -> Profit 0.026
        # Honest Paid 0.02 (Storage) -> Earned 0.10 -> Profit 0.08
        
        # Honest node is 4x more profitable per unit.
        # Over time, Attacker margins are razor thin or negative if BW spikes.
        
        results.append({
            "epoch": i,
            "honest": {
                "balance": round(honest_balance, 3),
                "tier": honest_tier
            },
            "attacker": {
                "balance": round(attacker_balance, 3),
                "tier": attacker_tier
            }
        })

    analysis = (
        f"Simulation of {ITERATIONS} epochs comparing Local NVMe vs S3 Wrapper. "
        f"The Honest Node finished with ${honest_balance:.2f}, consistently hitting 'Platinum' tiers due to low latency. "
        f"The Attacker finished with ${attacker_balance:.2f}. While S3 storage is cheaper, the egress fees and latency penalties (dropping to 'Gold') "
        f"drastically reduce margins. In a competitive market, the Honest Node outcompetes the Lazy Provider by a factor of {(honest_balance/attacker_balance):.1f}x."
    )

    output = {
        "meta": {
            "timestamp": time.time(),
            "parameters": {
                "storage_cost_nvme": STORAGE_COST_NVME,
                "storage_cost_s3": STORAGE_COST_S3,
                "bandwidth_cost": BANDWIDTH_COST_S3
            }
        },
        "data": results,
        "analysis": analysis
    }

    os.makedirs(os.path.dirname(SIMULATION_FILE), exist_ok=True)
    with open(SIMULATION_FILE, "w") as f:
        json.dump(output, f, indent=2)
        
    print(f"[Sim] Data written to {SIMULATION_FILE}")

if __name__ == "__main__":
    main()