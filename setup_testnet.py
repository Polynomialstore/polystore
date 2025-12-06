import json
import glob
import os
import sys

genesis_path = "nilchain_data/config/genesis.json"
gentx_pattern = "nilchain_data/config/gentx/*.json"
validator_key_path = "validator_key.json"

def get_gentx_file():
    gentx_files = glob.glob(gentx_pattern)
    if not gentx_files:
        print("Error: No gentx files found. Run `nilchaind genesis gentx` first.")
        sys.exit(1)
    return gentx_files[0]

def load_json(file_path):
    with open(file_path, "r") as f:
        return json.load(f)

def save_json(data, file_path):
    with open(file_path, "w") as f:
        json.dump(data, f, indent=1)

def fix_gentx_delegator_address(gentx_file, validator_addr):
    gentx = load_json(gentx_file)
    msg = gentx['body']['messages'][0]
    if msg['delegator_address'] == "":
        msg['delegator_address'] = validator_addr
        save_json(gentx, gentx_file)
        print(f"Fixed delegator_address in {gentx_file}")
    else:
        print(f"Delegator address already set in {gentx_file}")

def add_gentx_to_genesis(genesis_data, gentx_data):
    if "genutil" not in genesis_data["app_state"]:
        genesis_data["app_state"]["genutil"] = {"gen_txs": []}
    genesis_data["app_state"]["genutil"]["gen_txs"].append(gentx_data)
    return genesis_data

def add_validator_to_staking_genesis(genesis_data, validator_key_data, gentx_data):
    # Extract info from gentx
    msg_create_validator = gentx_data['body']['messages'][0]
    validator_address = msg_create_validator['validator_address']
    delegator_address = msg_create_validator['delegator_address']
    pubkey = msg_create_validator['pubkey']
    value = msg_create_validator['value'] # self delegation amount

    # Validator entry
    validator_entry = {
        "operator_address": validator_address,
        "consensus_pubkey": pubkey,
        "jailed": False,
        "status": "BOND_STATUS_BONDED", # Initial status for a single validator testnet
        "tokens": value["amount"],
        "delegator_shares": value["amount"], # Full self-delegation
        "description": msg_create_validator["description"],
        "unbonding_height": "0",
        "unbonding_time": "1970-01-01T00:00:00Z",
        "commission": {
            "rate": msg_create_validator["commission"]["rate"],
            "max_rate": msg_create_validator["commission"]["max_rate"],
            "max_change_rate": msg_create_validator["commission"]["max_change_rate"]
        },
        "min_self_delegation": msg_create_validator["min_self_delegation"]
    }

    # Delegation entry
    delegation_entry = {
        "delegator_address": delegator_address,
        "validator_address": validator_address,
        "shares": value["amount"]
    }

    # Populate staking module state
    if "staking" not in genesis_data["app_state"]:
        genesis_data["app_state"]["staking"] = {
            "params": {}, # Fill with default staking params if needed, or extract from existing genesis
            "last_validator_powers": [],
            "validators": [],
            "delegations": [],
            "unbonding_delegations": [],
            "redelegations": [],
            "exported": False
        }
    
    # Ensure staking params exist
    if not genesis_data["app_state"]["staking"].get("params"):
        # Use default params if not present
        genesis_data["app_state"]["staking"]["params"] = {
            "unbonding_time": "1814400s",
            "max_validators": 100,
            "max_entries": 7,
            "historical_entries": 10000,
            "bond_denom": "stake",
            "min_commission_rate": "0.000000000000000000"
        }

    genesis_data["app_state"]["staking"]["validators"].append(validator_entry)
    genesis_data["app_state"]["staking"]["delegations"].append(delegation_entry)
    genesis_data["app_state"]["staking"]["last_validator_powers"].append({
        "address": validator_address,
        "power": str(int(value["amount"]) // 1000000) # Assuming 1 stake = 1_000_000 units
    })
    
    # Update total supply if necessary (coins are usually added by add-genesis-account)
    # This might need to be verified against the actual amount added via add-genesis-account
    
    print("Added validator info directly to staking module in genesis.json")
    return genesis_data

if __name__ == "__main__":
    # Clean and setup
    os.system(f"rm -rf nilchain_data")
    os.system(f"nilchaind init testnode --chain-id testchain-1 --home nilchain_data")
    os.system(f"nilchaind keys add validator --home nilchain_data --keyring-backend test --output json > {validator_key_path}")

    # Load validator key
    validator_key = load_json(validator_key_path)
    validator_address_bech32 = validator_key['address']
    
    # Add genesis account (funds for delegator)
    os.system(f"nilchaind genesis add-genesis-account {validator_address_bech32} 1000000000000stake --home nilchain_data --keyring-backend test")
    
    # Generate gentx
    os.system(f"nilchaind genesis gentx validator 100000000stake --chain-id testchain-1 --home nilchain_data --keyring-backend test")
    
    # Fix delegator address in gentx
    gentx_file = get_gentx_file()
    fix_gentx_delegator_address(gentx_file, validator_address_bech32)
    
    # Load genesis and gentx
    genesis = load_json(genesis_path)
    gentx_data = load_json(gentx_file)

    # Add gentx to genutil (optional, but good for completeness if genutil works later)
    # genesis = add_gentx_to_genesis(genesis, gentx_data)

    # Manually add validator to staking module
    genesis = add_validator_to_staking_genesis(genesis, validator_key, gentx_data)

    # Save modified genesis
    save_json(genesis, genesis_path)

    print("Genesis file prepared with validator directly in staking module.")

    # Update app.toml for JSON-RPC
    app_toml_path = os.path.join("nilchain_data", "config", "app.toml")
    with open(app_toml_path, "r") as f:
        app_toml_content = f.read()

    app_toml_content = app_toml_content.replace(
        '[json-rpc]\n# Enable defines if the JSONRPC server should be enabled.\nenable = false',
        '[json-rpc]\n# Enable defines if the JSONRPC server should be enabled.\nenable = true'
    )
    app_toml_content = app_toml_content.replace(
        'address = "127.0.0.1:8545"',
        'address = "0.0.0.0:8545"'
    )

    with open(app_toml_path, "w") as f:
        f.write(app_toml_content)
    print("Updated app.toml for JSON-RPC settings.")

    # Try to start the chain
    print("\nAttempting to start nilchaind...")
    os.system(f"nilchaind start --home nilchain_data --pruning=nothing --minimum-gas-prices=0.0001stake > nilchain.log 2>&1 &")
    os.system("sleep 10")
    os.system("curl -H 'Content-Type: application/json' -X POST --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_chainId\",\"params\":[],\"id\":1}' http://127.0.0.0:8545 || true")
    os.system("sleep 5")
    os.system("curl -H 'Content-Type: application/json' -X POST --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_chainId\",\"params\":[],\"id\":1}' http://127.0.0.1:8545 || true")
