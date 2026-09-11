// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Undercloud} from "../src/Undercloud.sol";

/// @notice Deploys Undercloud with the arbiter key from .env and the rubric hash read from rubric.md
///         (single source of truth: the arbiter agent recomputes the same hash at startup).
contract Deploy is Script {
    function run() external {
        address arbiterAddr = vm.envAddress("ARBITER_ADDRESS");
        bytes memory arbiterPub = vm.envBytes("ARBITER_PUBKEY");
        bytes32 rubricHash = keccak256(bytes(vm.readFile("rubric.md")));
        uint64 qualityWindow = uint64(vm.envOr("QUALITY_WINDOW", uint256(90)));
        uint64 deliverTimeout = uint64(vm.envOr("DELIVER_TIMEOUT", uint256(180)));
        uint64 arbiterTimeout = uint64(vm.envOr("ARBITER_TIMEOUT", uint256(600)));
        vm.startBroadcast();
        Undercloud b = new Undercloud(arbiterAddr, arbiterPub, "claude-opus-5", rubricHash, qualityWindow, deliverTimeout, arbiterTimeout);
        vm.stopBroadcast();
        console.log("Undercloud:", address(b));
        console.log("rubricHash:");
        console.logBytes32(rubricHash);
    }
}
