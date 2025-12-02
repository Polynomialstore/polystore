import subprocess
import time
import random
import signal
import os
import sys
import re

# Configuration
NUM_NODES = 5
START_PORT = 9000
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "../../"))
NIL_P2P_BIN = os.path.join(PROJECT_ROOT, "nil_p2p/target/debug/nil_p2p")
TEST_DURATION_SEC = 30

def start_node(port, seed):
    """Starts a nil_p2p node process."""
    cmd = [NIL_P2P_BIN, "--port", str(port), "--seed", str(seed)]
    # We capture stdout/stderr to verify gossip reception
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE, # Needed to send commands
        text=True
    )
    print(f"🚀 Started Node {seed} on port {port} (PID: {process.pid})")
    return process

def kill_node(process, seed):
    """Kills a node process."""
    print(f"💀 Killing Node {seed} (PID: {process.pid})...")
    os.kill(process.pid, signal.SIGKILL)
    # process.terminate() # Gracious
    return True

def main():
    print("--- 🌪️  Starting Chaos Test  🌪️ ---")
    
    # Ensure binary exists
    if not os.path.exists(NIL_P2P_BIN):
        print(f"Error: Binary not found at {NIL_P2P_BIN}. Please run 'cargo build -p nil_p2p' first.")
        sys.exit(1)

    nodes = []
    node_map = {} # PID -> Seed

    # 1. Spin up the cluster
    for i in range(NUM_NODES):
        port = START_PORT + i
        seed = i
        p = start_node(port, seed)
        nodes.append(p)
        node_map[p.pid] = seed
    
    print(f"Waiting 5s for mDNS discovery...")
    time.sleep(5)

    # 2. Announce a shard from Node 0
    print("📢 Node 0 announcing 'shard-chaos-test-1'...")
    try:
        # Send "announce shard-chaos-test-1\n" to Node 0's stdin
        nodes[0].stdin.write("announce shard-chaos-test-1\n")
        nodes[0].stdin.flush()
    except Exception as e:
        print(f"Failed to write to Node 0: {e}")

    # 3. Wait for propagation
    print("Waiting 3s for gossip...")
    time.sleep(3)

    # 4. Unleash Chaos: Kill 2 random nodes (excluding Node 0, to see if others got it)
    # Actually, let's kill Node 0 (the source) and see if the message survived in others!
    victim_indices = [0, 2] 
    
    for idx in victim_indices:
        kill_node(nodes[idx], idx)

    # 5. Verify Survival: Check logs of survivors
    print("🔍 Verifying gossip propagation in surviving nodes...")
    success_count = 0
    survivors = [i for i in range(NUM_NODES) if i not in victim_indices]

    for i in survivors:
        p = nodes[i]
        # Non-blocking read of whatever is in the buffer
        # This is tricky with Popen. We'll use a simple poll/communicate with timeout logic
        # But communicate waits for exit. 
        # Since we just want to see if they *already* got it, we can read current stdout.
        # For this simple test, we will kill them now to read their output safely.
        
        print(f"Stopping survivor Node {i} to read logs...")
        p.terminate()
        try:
            stdout, stderr = p.communicate(timeout=2)
            if "shard-chaos-test-1" in stdout or "shard-chaos-test-1" in stderr: # tracing logs might be in stderr
                print(f"✅ Node {i} RECEIVED the shard announcement!")
                success_count += 1
            else:
                print(f"❌ Node {i} did NOT receive the shard announcement.")
                # print(f"Debug Log Node {i}:\n{stdout}\n{stderr}") 
        except Exception as e:
            print(f"Error reading logs from Node {i}: {e}")

    # Cleanup remaining (if any)
    for p in nodes:
        if p.poll() is None:
            p.kill()

    print("-" * 30)
    if success_count >= len(survivors) - 1: # Allow 1 failure/race condition
        print(f"🏆 CHAOS TEST PASSED: {success_count}/{len(survivors)} survivors had the data.")
        sys.exit(0)
    else:
        print(f"💥 CHAOS TEST FAILED: Only {success_count}/{len(survivors)} survivors had the data.")
        sys.exit(1)

if __name__ == "__main__":
    main()
