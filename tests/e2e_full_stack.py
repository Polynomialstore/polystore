import sys
import json
import time
import requests
import bech32
import binascii
import base64
from eth_account import Account
from eth_account.messages import encode_typed_data

# Configuration
GATEWAY_URL = "http://localhost:8080"
LCD_URL = "http://localhost:1317"
FAUCET_URL = "http://localhost:8081"
EVM_CHAIN_ID = 31337
COSMOS_CHAIN_ID = "test-1"
VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000000"

# Generate a random wallet
account = Account.create()
print(f"Using address: {account.address}")
print(f"Private key: {account.key.hex()}")

def eth_to_nil(eth_address):
    # Strip 0x
    if eth_address.startswith('0x'):
        eth_address = eth_address[2:]
    # Convert hex to bytes
    data = binascii.unhexlify(eth_address)
    # Convert to 5-bit words
    five_bit_data = bech32.convertbits(data, 8, 5)
    # Encode
    return bech32.bech32_encode("nil", five_bit_data)

def request_funds(eth_address):
    nil_address = eth_to_nil(eth_address)
    print(f"Requesting funds for {nil_address}...")
    try:
        resp = requests.post(f"{FAUCET_URL}/faucet", json={"address": nil_address})
        if resp.status_code != 200:
            print(f"Faucet failed: {resp.text}")
            sys.exit(1)
        data = resp.json()
        print(f"Faucet tx: {data.get('tx_hash')}")
        # Wait for funds
        print("Waiting for funds to be confirmed...")
        time.sleep(6)
    except Exception as e:
        print(f"Faucet error: {e}")
        sys.exit(1)

# --- 1. Create Deal ---
def create_deal():
    nonce = 1 # Simple nonce handling
    duration = 100
    initial_escrow = 1000000
    max_monthly_spend = 5000000
    replication = 1
    service_hint = f"General:replicas={replication}"

    domain_data = {
        "name": "NilStore",
        "version": "1",
        "chainId": EVM_CHAIN_ID,
        "verifyingContract": VERIFYING_CONTRACT,
    }

    message_types = {
        "CreateDeal": [
            {"name": "creator", "type": "address"},
            {"name": "duration", "type": "uint64"},
            {"name": "service_hint", "type": "string"},
            {"name": "initial_escrow", "type": "string"},
            {"name": "max_monthly_spend", "type": "string"},
            {"name": "nonce", "type": "uint64"},
        ]
    }

    message_data = {
        "creator": account.address,
        "duration": duration,
        "service_hint": service_hint,
        "initial_escrow": str(initial_escrow),
        "max_monthly_spend": str(max_monthly_spend),
        "nonce": nonce,
    }

    # Sign
    signable_message = encode_typed_data(domain_data, message_types, message_data)
    signed_message = Account.sign_message(signable_message, account.key)
    signature = signed_message.signature.hex()

    # Construct Intent
    intent = {
        "creator_evm": account.address,
        "duration_blocks": duration,
        "service_hint": service_hint,
        "initial_escrow": str(initial_escrow),
        "max_monthly_spend": str(max_monthly_spend),
        "nonce": nonce,
        "chain_id": COSMOS_CHAIN_ID,
    }

    print("Submitting CreateDeal...")
    resp = requests.post(f"{GATEWAY_URL}/gateway/create-deal-evm", json={
        "intent": intent,
        "evm_signature": signature,
    })
    
    if resp.status_code != 200:
        print(f"CreateDeal failed: {resp.text}")
        sys.exit(1)
    
    data = resp.json()
    print(f"CreateDeal Success: {data}")
    return data['deal_id']

# --- 2. Verify Deal ---
def verify_deal(deal_id):
    print(f"Verifying Deal {deal_id}...")
    for _ in range(10):
        try:
            resp = requests.get(f"{LCD_URL}/nilchain/nilchain/v1/deals/{deal_id}")
            if resp.status_code == 200:
                data = resp.json()
                if 'deal' in data:
                    deal = data['deal']
                    print(f"Deal found: {deal}")
                    return deal
        except Exception as e:
            print(f"Polling error: {e}")
            import traceback
            traceback.print_exc()
        time.sleep(1)
    print("Deal not found after polling")
    sys.exit(1)

# --- 3. Upload Content ---
def upload_content():
    content = b"Hello NilStore E2E Test" * 100
    files = {'file': ('test.txt', content)}
    
    print("Uploading file...")
    resp = requests.post(f"{GATEWAY_URL}/gateway/upload?owner={account.address}", files=files)
    if resp.status_code != 200:
        print(f"Upload failed: {resp.text}")
        sys.exit(1)
    
    data = resp.json()
    print(f"Upload Success: {data}")
    return data['cid'], data['size_bytes'], content

# --- 4. Update Content ---
def update_content(deal_id, cid, size_bytes):
    nonce = 2 # Increment nonce
    
    domain_data = {
        "name": "NilStore",
        "version": "1",
        "chainId": EVM_CHAIN_ID,
        "verifyingContract": VERIFYING_CONTRACT,
    }

    message_types = {
        "UpdateContent": [
            {"name": "creator", "type": "address"},
            {"name": "deal_id", "type": "uint64"},
            {"name": "cid", "type": "string"},
            {"name": "size", "type": "uint64"},
            {"name": "nonce", "type": "uint64"},
        ]
    }

    message_data = {
        "creator": account.address,
        "deal_id": int(deal_id),
        "cid": cid,
        "size": int(size_bytes),
        "nonce": nonce,
    }

    # Sign
    signable_message = encode_typed_data(domain_data, message_types, message_data)
    signed_message = Account.sign_message(signable_message, account.key)
    signature = signed_message.signature.hex()

    intent = {
        "creator_evm": account.address,
        "deal_id": int(deal_id),
        "cid": cid,
        "size_bytes": int(size_bytes),
        "nonce": nonce,
        "chain_id": COSMOS_CHAIN_ID,
    }

    print("Submitting UpdateContent...")
    resp = requests.post(f"{GATEWAY_URL}/gateway/update-deal-content-evm", json={
        "intent": intent,
        "evm_signature": signature,
    })

    if resp.status_code != 200:
        print(f"UpdateContent failed: {resp.text}")
        sys.exit(1)
    
    data = resp.json()
    print(f"UpdateContent Success: {data}")
    return data

# --- 5b. Fetch & Verify Bytes ---
def fetch_and_verify(cid, deal_id, owner, original_bytes):
    print("Fetching from gateway to verify content bytes...")
    fetch_url = f"{GATEWAY_URL}/gateway/fetch/{cid}?deal_id={deal_id}&owner={owner}&file_path=test.txt"
    fetched = requests.get(fetch_url)
    if fetched.status_code != 200:
        print(f"Fetch failed: HTTP {fetched.status_code} {fetched.text}")
        sys.exit(1)
    if fetched.content != original_bytes:
        print("❌ Fetched content does not match original upload")
        sys.exit(1)
    print("✅ Gateway fetch returned byte-identical content")

# --- 5. Final Verify ---
def verify_final(deal_id, cid, size_bytes):
    print("Verifying final state...")
    for _ in range(20):
        try:
            resp = requests.get(f"{LCD_URL}/nilchain/nilchain/v1/deals/{deal_id}")
            data = resp.json()
            if 'deal' not in data:
                time.sleep(1)
                continue
                
            deal = data['deal']
            
            # Check CID (LCD returns Base64, Gateway returns Hex)
            deal_cid_raw = deal.get('cid') or deal.get('manifest_root')
            deal_cid_hex = None
            if deal_cid_raw:
                try:
                    # Try Base64 decode
                    decoded = base64.b64decode(deal_cid_raw)
                    deal_cid_hex = "0x" + decoded.hex()
                except:
                    deal_cid_hex = deal_cid_raw

            # Check Size
            deal_content_size_bytes = int(deal.get('size') or deal.get('size_bytes') or 0)
            
            # Compare (Gateway CID has 0x prefix)
            if deal_cid_hex == cid and deal_content_size_bytes == size_bytes:
                print("Final Verification PASSED!")
                return
            
            print(f"Waiting for update... CID: {deal_cid_hex} (want {cid}), Size: {deal_content_size_bytes} (want {size_bytes})")
        except Exception as e:
            print(f"Polling error: {e}")
            import traceback
            traceback.print_exc()
        
        time.sleep(1.5)

    print("Final Verification FAILED: Timeout")
    sys.exit(1)


if __name__ == "__main__":
    try:
        request_funds(account.address)
        deal_id = create_deal()
        verify_deal(deal_id)
        cid, size_bytes, content = upload_content()
        update_content(deal_id, cid, size_bytes)
        verify_final(deal_id, cid, size_bytes)
        fetch_and_verify(cid, deal_id, eth_to_nil(account.address), content)
    except Exception as e:
        print(f"Test failed with exception: {e}")
        sys.exit(1)
