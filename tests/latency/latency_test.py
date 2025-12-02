import subprocess
import time
import os
import sys
import re
import datetime
import select

# Configuration
NUM_NODES = 2
START_PORT = 9000
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "../../"))
NIL_P2P_BIN = os.path.join(PROJECT_ROOT, "nil_p2p/target/debug/nil_p2p")
ANNOUNCE_SHARD_ID = "shard-latency-test-1"

def start_node(port, seed):
    """Starts a nil_p2p node process."""
    cmd = [NIL_P2P_BIN, "--port", str(port), "--seed", str(seed)]
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1, # Line-buffered output
        universal_newlines=True # Ensure text mode
    )
    print(f"🚀 Started Node {seed} on port {port} (PID: {process.pid})")
    return process

def main():
    print("--- ⏱️  Starting Latency Test  ⏱️ ---")
    
    if not os.path.exists(NIL_P2P_BIN):
        print(f"Error: Binary not found at {NIL_P2P_BIN}. Please run 'cargo build -p nil_p2p' first.")
        sys.exit(1)

    nodes = []
    
    # 1. Spin up two nodes
    for i in range(NUM_NODES):
        port = START_PORT + i
        seed = i
        p = start_node(port, seed)
        nodes.append(p)
    
    print(f"Waiting 5s for mDNS discovery between nodes...")
    time.sleep(5)

    node_a = nodes[0]
    node_b = nodes[1]

    start_time = None
    
    # 2. Announce a shard from Node A
    print(f"📢 Node A ({node_a.pid}) announcing '{ANNOUNCE_SHARD_ID}'...")
    try:
        start_time = time.monotonic()
        node_a.stdin.write(f"announce {ANNOUNCE_SHARD_ID}\n")
        node_a.stdin.flush()
    except Exception as e:
        print(f"Failed to write to Node A: {e}")
        cleanup_nodes(nodes)
        sys.exit(1)

    # 3. Monitor Node B's output for receipt
    print(f"🔍 Monitoring Node B ({node_b.pid}) for shard announcement...")
    received_time = None
    timeout_sec = 10 # Max wait for announcement
    
    start_monitor = time.monotonic()
    
    while (time.monotonic() - start_monitor) < timeout_sec:
        # Check if stdout has data ready
        reads = [node_b.stdout.fileno()]
        ret = select.select(reads, [], [], 0.1) # 0.1s timeout

        if ret[0]:
            line = node_b.stdout.readline()
            if line:
                print(f"Node B Log: {line.strip()}") # Debugging
                if ANNOUNCE_SHARD_ID in line and "Received announcement" in line:
                    received_time = time.monotonic()
                    print(f"✅ Node B received the announcement.")
                    break
        else:
            # No data ready, loop continues
            pass
    
    # 4. Calculate and report latency
    if start_time is not None and received_time is not None:
        latency = (received_time - start_time) * 1000 # in ms
        print(f"⏱️  Latency for '{ANNOUNCE_SHARD_ID}': {latency:.2f} ms")
        print("🏆 LATENCY TEST PASSED")
        cleanup_nodes(nodes) # Ensure cleanup on success too
        sys.exit(0)
    else:
        print("💥 LATENCY TEST FAILED: Announcement not received by Node B within timeout.")
        cleanup_nodes(nodes)
        sys.exit(1)

def cleanup_nodes(nodes):
    """Ensures all child processes are terminated."""
    print("Cleaning up nodes...")
    for p in nodes:
        if p.poll() is None: # If process is still running
            # print(f"Terminating PID: {p.pid}")
            p.terminate()
            try:
                p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                # print(f"Killing PID: {p.pid}")
                p.kill()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted by user.")
