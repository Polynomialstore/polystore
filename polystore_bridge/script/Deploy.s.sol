// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import { Script, console } from "forge-std/Script.sol";
import "../src/PolyStoreBridge.sol";

contract Deploy is Script {
    function setUp() public {}

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        PolyStoreBridge bridge = new PolyStoreBridge();
        console.log("PolyStoreBridge deployed at:", address(bridge));

        vm.stopBroadcast();
    }
}
