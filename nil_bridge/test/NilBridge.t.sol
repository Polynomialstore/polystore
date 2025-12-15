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

    function test_RevertWhen_UpdateOldBlock() public {
        bytes32 root1 = keccak256("root1");
        bridge.updateStateRoot(10, root1);
        
        bytes32 root2 = keccak256("root2");
        // Should fail because 5 < 10
        vm.expectRevert("Block height must increase");
        bridge.updateStateRoot(5, root2);
    }

    function test_VerifyInclusion() public {
        bytes32 leaf1 = keccak256("leaf1");
        bytes32 leaf2 = keccak256("leaf2");
        
        // Construct Root (Sorted Pair)
        bytes32 root;
        if (leaf1 <= leaf2) {
            root = keccak256(abi.encodePacked(leaf1, leaf2));
        } else {
            root = keccak256(abi.encodePacked(leaf2, leaf1));
        }

        bridge.updateStateRoot(1, root);

        // Proof for leaf1 is just [leaf2]
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf2;

        assertTrue(bridge.verifyInclusion(leaf1, proof));
        
        // Proof for leaf2 is just [leaf1]
        proof[0] = leaf1;
        assertTrue(bridge.verifyInclusion(leaf2, proof));

        // Wrong proof
        proof[0] = keccak256("wrong");
        assertFalse(bridge.verifyInclusion(leaf1, proof));
    }
}
