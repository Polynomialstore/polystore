// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {NilBridge} from "../src/NilBridge.sol";

contract NilBridgeTest is Test {
    NilBridge public bridge;

    function setUp() public {
        bridge = new NilBridge();
    }

    function test_UpdateStateRoot() public {
        bytes32 root = keccak256("test");
        bridge.updateStateRoot(1, root);
        
        assertEq(bridge.latestStateRoot(), root);
        assertEq(bridge.latestBlockHeight(), 1);
    }

    function testFail_UpdateOldBlock() public {
        bytes32 root1 = keccak256("root1");
        bridge.updateStateRoot(10, root1);
        
        bytes32 root2 = keccak256("root2");
        // Should fail because 5 < 10
        bridge.updateStateRoot(5, root2);
    }
}
