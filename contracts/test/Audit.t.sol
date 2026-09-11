// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Undercloud} from "../src/Undercloud.sol";

/// @title Audit regression tests for Undercloud.sol (adversarial review, 2026-09-10).
/// @notice The review found four weaknesses; two were fixed on-chain and are locked in here, the other
///         two are mitigated off-chain and documented by a test that pins the contract's behaviour.
///
///   Fixed  1  Push payments could be blocked by a payee that rejects ETH (a contract with a reverting
///             receive()), locking the counterparty's funds forever (buyer: rule/timeoutDispute; seller:
///             refundUndelivered/release). Now `_pay` credits `owed[to]` and emits `PaymentDeferred`
///             instead of reverting; the payee pulls with `withdrawOwed()`. Σ owed is part of I1.
///   Fixed  2  `deliver` had no deadline, so a ghosting seller could front-run `refundUndelivered` with
///             junk after `deliverTimeout`. Now `deliver` reverts `WindowClosed` at paidAt + deliverTimeout.
///   Pinned 3  `list` only enforces `resolveBy > expiresAt`, so a seller can make the outcome-dispute
///             window empty. Mitigated by the buyer agents (they refuse listings whose resolveBy is
///             closer than deliverTimeout + qualityWindow + MIN_OUTCOME_WINDOW); the test documents it.
contract AuditTest is Test {
    Undercloud b;

    address arbiter = makeAddr("arbiter");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address rando = makeAddr("rando");
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    bytes PUBKEY = abi.encodePacked(hex"04", bytes32(uint256(1)), bytes32(uint256(2)));

    uint64 constant QUALITY_WINDOW = 90;
    uint64 constant DELIVER_TIMEOUT = 180;
    uint64 constant ARBITER_TIMEOUT = 600;

    uint256 constant P = 0.001 ether;
    uint256 constant B = 2 * P;
    uint256 constant D = (P + 1) / 2;
    uint256 constant F = P * 200 / 10_000;
    uint64 constant T0 = 1_800_000_000;
    uint256 nonce;

    function setUp() public {
        vm.warp(T0);
        b = new Undercloud(arbiter, PUBKEY, "claude-opus-5", keccak256("rubric"), QUALITY_WINDOW, DELIVER_TIMEOUT, ARBITER_TIMEOUT);
        vm.deal(seller, 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(rando, 1 ether);
    }

    function _hash() internal returns (bytes32) { return keccak256(abi.encode("audit", nonce++)); }

    function _listFrom(address who, uint256 price, uint64 expiresAt, uint64 resolveBy) internal returns (uint256 id) {
        bytes32 h = _hash();
        vm.prank(who);
        id = b.list{value: 2 * price}(h, Undercloud.Category.CapacityRelease, uint96(price), expiresAt, resolveBy, 15, "label");
    }

    function _list(address who, uint256 price) internal returns (uint256) {
        return _listFrom(who, price, uint64(block.timestamp + 180), uint64(block.timestamp + 330));
    }

    /// @dev I1 including the pull ledger, for the addresses this file uses.
    function _assertI1(address extra) internal view {
        uint256 total;
        uint256 n = b.listingCount();
        for (uint256 i = 0; i < n; i++) {
            Undercloud.Listing memory L = b.getListing(i);
            if (!L.bondWithdrawn) total += L.bond;
            bool escrowed = L.status == Undercloud.Status.Paid || L.status == Undercloud.Status.Delivered
                || (L.status == Undercloud.Status.Disputed && !L.afterRelease);
            if (escrowed) total += L.price;
            if (L.status == Undercloud.Status.Disputed) total += L.disputeBond;
        }
        total += b.owed(seller) + b.owed(buyer) + b.owed(rando) + b.owed(arbiter) + b.owed(BURN) + b.owed(extra);
        assertEq(address(b).balance, total, "I1 (incl. owed)");
    }

    // ================================================================== fix 1: reverting buyer

    function test_RevertingBuyer_RulingLands_PayoutDeferredToOwed() public {
        RejectsEth badBuyer = new RejectsEth();
        vm.deal(address(badBuyer), 1 ether);

        uint256 id = _list(seller, P);
        badBuyer.buy(b, id, PUBKEY, P);
        vm.prank(seller);
        b.deliver(id, hex"c1c1c1c1");
        badBuyer.dispute(b, id, Undercloud.Reason.NotAsLabeled, D);
        assertEq(address(b).balance, P + B + D);

        // Honest arbiter finds for the buyer: the ruling lands even though the buyer rejects ETH.
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Ruled(id, true, "buyer is right", P + D + P / 2, 0, B - P / 2);
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.PaymentDeferred(address(badBuyer), P + D + P / 2);
        vm.prank(arbiter);
        b.rule(id, true, "buyer is right");
        assertTrue(b.getListing(id).status == Undercloud.Status.RuledBuyer);
        assertEq(BURN.balance - burnBefore, B - P / 2, "1.5P burned as in the money table");
        assertEq(b.owed(address(badBuyer)), P + D + P / 2, "buyer's payout parked in the pull ledger");
        assertEq(address(b).balance, P + D + P / 2, "only the deferred payout is still inside");
        _assertI1(address(badBuyer));

        // While it still rejects ETH, pulling fails loudly and the credit stays intact.
        vm.expectRevert(Undercloud.PayFailed.selector);
        badBuyer.pull(b);
        assertEq(b.owed(address(badBuyer)), P + D + P / 2);

        // Once it accepts ETH, it pulls exactly what it is owed, once.
        badBuyer.setAccept(true);
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.OwedWithdrawn(address(badBuyer), P + D + P / 2);
        badBuyer.pull(b);
        assertEq(address(badBuyer).balance, 1 ether - P - D + P + D + P / 2);
        assertEq(b.owed(address(badBuyer)), 0);
        assertEq(address(b).balance, 0);
        vm.expectRevert(Undercloud.BadValue.selector); // nothing left to pull
        badBuyer.pull(b);
    }

    function test_RevertingBuyer_TimeoutDisputeLands() public {
        RejectsEth badBuyer = new RejectsEth();
        vm.deal(address(badBuyer), 1 ether);
        uint256 id = _list(seller, P);
        badBuyer.buy(b, id, PUBKEY, P);
        vm.prank(seller);
        b.deliver(id, hex"c1c1c1c1");
        badBuyer.dispute(b, id, Undercloud.Reason.NotAsLabeled, D);
        vm.warp(block.timestamp + ARBITER_TIMEOUT);
        uint256 sellerBefore = seller.balance;
        vm.prank(rando);
        b.timeoutDispute(id); // the keeper fallback is no longer dead
        assertTrue(b.getListing(id).status == Undercloud.Status.Unadjudicated);
        assertEq(seller.balance - sellerBefore, (P - P / 2) + B, "seller's half + bond paid immediately");
        assertEq(b.owed(address(badBuyer)), D + P / 2, "buyer's half + dispute bond deferred");
        _assertI1(address(badBuyer));
    }

    // ================================================================== fix 1: reverting seller

    function test_RevertingSeller_RefundAndReleaseLand() public {
        RejectsEth badSeller = new RejectsEth();
        vm.deal(address(badSeller), 1 ether);

        // (a) Ghost seller: the buyer's refund lands; the seller's 90% of the bond is deferred.
        uint256 id = badSeller.list(b, _hash(), P, uint64(block.timestamp + 180), uint64(block.timestamp + 330));
        vm.prank(buyer);
        b.buy{value: P}(id, PUBKEY);
        vm.warp(block.timestamp + DELIVER_TIMEOUT);
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        b.refundUndelivered(id);
        assertTrue(b.getListing(id).status == Undercloud.Status.Refunded);
        assertEq(buyer.balance - buyerBefore, P + B / 10, "buyer refunded + 10% of the bond");
        assertEq(b.owed(address(badSeller)), B - B / 10);
        _assertI1(address(badSeller));

        // (b) Delivered + window closed: release lands, the seller's 0.98P is deferred, the fee burns.
        uint256 id2 = badSeller.list(b, _hash(), P, uint64(block.timestamp + 180), uint64(block.timestamp + 330));
        vm.prank(buyer);
        b.buy{value: P}(id2, PUBKEY);
        badSeller.deliver(b, id2, hex"c1c1c1c1");
        vm.warp(block.timestamp + QUALITY_WINDOW);
        uint256 burnBefore = BURN.balance;
        vm.prank(rando);
        b.release(id2);
        assertTrue(b.getListing(id2).status == Undercloud.Status.Released);
        assertEq(BURN.balance - burnBefore, F);
        assertEq(b.owed(address(badSeller)), (B - B / 10) + (P - F), "credits accumulate");
        _assertI1(address(badSeller));

        // The seller can collect everything in one pull once it accepts ETH.
        badSeller.setAccept(true);
        uint256 before = address(badSeller).balance;
        badSeller.pull(b);
        assertEq(address(badSeller).balance - before, (B - B / 10) + (P - F));
        assertEq(b.owed(address(badSeller)), 0);
        _assertI1(address(badSeller));
    }

    // ================================================================== fix 2: late delivery race

    function test_LateDelivery_CannotBeatRefundAfterDeliverTimeout() public {
        uint256 id = _list(seller, P);
        vm.prank(buyer);
        b.buy{value: P}(id, PUBKEY);
        vm.warp(block.timestamp + 10 * DELIVER_TIMEOUT);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowClosed.selector);
        b.deliver(id, hex"00");
        assertTrue(b.getListing(id).status == Undercloud.Status.Paid);
        vm.prank(buyer);
        b.refundUndelivered(id);
        assertTrue(b.getListing(id).status == Undercloud.Status.Refunded);
    }

    // ================================================================== pinned 3: resolveBy too early

    /// @dev Documents (does not fix) that a seller-chosen resolveBy = expiresAt + 1 empties the outcome
    ///      window. The contract accepts it; the buyer agents refuse such listings (buyer.ts
    ///      MIN_OUTCOME_WINDOW). If `list` ever enforces resolveBy >= expiresAt + deliverTimeout +
    ///      qualityWindow, flip the first assertion to expectRevert(BadTiming).
    function test_Pinned_SellerChosenResolveBy_VoidsOutcomeDisputeWindow() public {
        uint64 expiresAt = uint64(block.timestamp + 180);
        uint64 resolveBy = expiresAt + 1; // accepted: only `resolveBy > expiresAt` is enforced
        uint256 id = _listFrom(seller, P, expiresAt, resolveBy);

        vm.warp(expiresAt - 1);
        vm.prank(buyer);
        b.buy{value: P}(id, PUBKEY);
        vm.prank(seller);
        b.deliver(id, hex"c1c1c1c1");

        vm.warp(block.timestamp + QUALITY_WINDOW);
        assertGt(block.timestamp, resolveBy);
        vm.prank(rando);
        b.release(id);

        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowClosed.selector);
        b.dispute{value: D}(id, Undercloud.Reason.DidNotHappen, hex"5ea1ed", "e");
        uint256 before = seller.balance;
        vm.prank(seller);
        b.withdrawBond(id);
        assertEq(seller.balance - before, B, "bond out immediately after release: zero seconds on the hook");
        assertEq(address(b).balance, 0);
    }

    // ================================================================== sanity: guards that hold

    /// @dev `uint96(msg.value)` cannot truncate: 2 * price > uint96.max is rejected before the cast.
    function test_Sanity_MaxPriceBond_RevertsInsteadOfTruncating() public {
        uint256 maxPrice = type(uint96).max;
        vm.deal(seller, 2 * maxPrice);
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.list{value: 2 * maxPrice}(_hash(), Undercloud.Category.CapacityRelease, uint96(maxPrice),
            uint64(block.timestamp + 180), uint64(block.timestamp + 330), 15, "label");
        uint256 okPrice = type(uint96).max / 2;
        vm.prank(seller);
        uint256 id = b.list{value: 2 * okPrice}(_hash(), Undercloud.Category.CapacityRelease, uint96(okPrice),
            uint64(block.timestamp + 180), uint64(block.timestamp + 330), 15, "label");
        assertEq(b.getListing(id).bond, 2 * okPrice);
        assertEq(b.getListing(id).price, okPrice);
    }

    /// @dev Reentrancy: a seller re-entering `withdrawBond` from its payout hits the lock. The inner call
    ///      reverts, so the push fails and the payout is deferred - the outer settlement still lands with
    ///      the right state and the money is recoverable via withdrawOwed once the seller behaves.
    function test_Sanity_ReentrantSeller_IsBlocked_AndDeferred() public {
        Reenterer evil = new Reenterer();
        vm.deal(address(evil), 1 ether);
        uint256 id = evil.list(b, _hash(), P, uint64(block.timestamp + 180), uint64(block.timestamp + 330));
        vm.prank(buyer);
        b.buy{value: P}(id, PUBKEY);
        evil.deliver(b, id, hex"c1");
        vm.warp(block.timestamp + 330); // past the window AND past resolveBy
        evil.arm(id);
        vm.prank(rando);
        b.release(id);
        assertTrue(b.getListing(id).status == Undercloud.Status.Released);
        assertEq(b.getListing(id).bond, B, "the re-entered withdrawBond did NOT go through");
        assertEq(b.owed(address(evil)), P - F, "payout deferred instead of reverting the release");
        evil.disarm();
        vm.prank(rando);
        b.withdrawBond(id);
        evil.pull(b);
        assertEq(b.owed(address(evil)), 0);
        assertEq(address(b).balance, 0);
        assertEq(address(evil).balance, 1 ether - B + (P - F) + B);
    }

    /// @dev A payee that burns all forwarded gas cannot make the settlement run out of gas: the stipend
    ///      is bounded, so the caller's tx still completes with the payout deferred.
    function test_Sanity_GasGuzzlingPayee_IsDeferred() public {
        GasGuzzler g = new GasGuzzler();
        vm.deal(address(g), 1 ether);
        uint256 id = g.list(b, _hash(), P, uint64(block.timestamp + 180), uint64(block.timestamp + 330));
        vm.prank(buyer);
        b.buy{value: P}(id, PUBKEY);
        vm.warp(block.timestamp + DELIVER_TIMEOUT);
        vm.prank(buyer);
        b.refundUndelivered{gas: 400_000}(id);
        assertTrue(b.getListing(id).status == Undercloud.Status.Refunded);
        assertEq(b.owed(address(g)), B - B / 10);
    }

    /// @dev Odd prices: every wei of P + B + D is conserved in both outcome rulings (floor/ceil split).
    function testFuzz_OutcomeDispute_ConservesValue(uint96 price, bool buyerWins) public {
        uint256 p = bound(uint256(price), 1, 1e18);
        uint256 d = (p + 1) / 2;
        uint256 id = _list(seller, p);
        vm.prank(buyer);
        b.buy{value: p}(id, PUBKEY);
        vm.prank(seller);
        b.deliver(id, hex"c1");
        vm.warp(block.timestamp + QUALITY_WINDOW);
        b.release(id);
        vm.prank(buyer);
        b.dispute{value: d}(id, Undercloud.Reason.DidNotHappen, hex"5e", "e");
        uint256 buyerStart = buyer.balance; uint256 sellerStart = seller.balance; uint256 burnStart = BURN.balance;
        uint256 inside = address(b).balance;
        assertEq(inside, 2 * p + d);
        vm.prank(arbiter);
        b.rule(id, buyerWins, "fuzz");
        if (!buyerWins) { vm.warp(b.getListing(id).resolveBy); b.withdrawBond(id); }
        uint256 out = (buyer.balance - buyerStart) + (seller.balance - sellerStart) + (BURN.balance - burnStart);
        assertEq(out, inside, "I3: everything inside went to exactly buyer/seller/BURN");
        assertEq(address(b).balance, 0);
        if (buyerWins) {
            assertEq(buyer.balance - buyerStart, p + d + p / 2);
            assertEq(BURN.balance - burnStart, p - p / 2, "burned = ceil(P/2) for odd P");
        }
    }
}

/// @dev A counterparty that refuses ETH until told otherwise. Realistic: any contract wallet with a
///      guarded/absent receive().
contract RejectsEth {
    bool public accept;
    receive() external payable { if (!accept) revert("no"); }
    function setAccept(bool a) external { accept = a; }
    function list(Undercloud b, bytes32 h, uint256 price, uint64 e, uint64 r) external returns (uint256) {
        return b.list{value: 2 * price}(h, Undercloud.Category.CapacityRelease, uint96(price), e, r, 15, "label");
    }
    function buy(Undercloud b, uint256 id, bytes memory k, uint256 v) external { b.buy{value: v}(id, k); }
    function deliver(Undercloud b, uint256 id, bytes memory c) external { b.deliver(id, c); }
    function dispute(Undercloud b, uint256 id, Undercloud.Reason r, uint256 v) external {
        b.dispute{value: v}(id, r, hex"5ea1ed", "e");
    }
    function pull(Undercloud b) external { b.withdrawOwed(); }
}

/// @dev A seller that re-enters withdrawBond from its payout while armed.
contract Reenterer {
    Undercloud target; uint256 id; bool armed;
    receive() external payable { if (armed) { target.withdrawBond(id); } }
    function arm(uint256 _id) external { id = _id; armed = true; }
    function disarm() external { armed = false; }
    function list(Undercloud b, bytes32 h, uint256 price, uint64 e, uint64 r) external returns (uint256) {
        target = b;
        return b.list{value: 2 * price}(h, Undercloud.Category.CapacityRelease, uint96(price), e, r, 15, "label");
    }
    function deliver(Undercloud b, uint256 _id, bytes memory c) external { b.deliver(_id, c); }
    function pull(Undercloud b) external { b.withdrawOwed(); }
}

/// @dev A payee whose receive() spins until it runs out of gas.
contract GasGuzzler {
    receive() external payable { while (true) {} }
    function list(Undercloud b, bytes32 h, uint256 price, uint64 e, uint64 r) external returns (uint256) {
        return b.list{value: 2 * price}(h, Undercloud.Category.CapacityRelease, uint96(price), e, r, 15, "label");
    }
}
