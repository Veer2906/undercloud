// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Undercloud} from "../src/Undercloud.sol";

/// @title Undercloud tests - the 13 tests from SPEC §4 plus invariant I1 after every step,
///        the extra money-table rows (outcome seller-wins, outcome timeout) and two fuzz tests.
/// @dev   Every test calls _assertI1() after every state-changing step:
///        contract balance == Σ bond(if !bondWithdrawn) + price(if escrowed) + disputeBond(if Disputed).
contract UndercloudTest is Test {
    Undercloud b;

    address arbiter = makeAddr("arbiter");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address rando = makeAddr("rando");
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    // A syntactically valid 65-byte uncompressed secp256k1 key (0x04 || X || Y). Not a real point;
    // the contract only checks length and prefix.
    bytes PUBKEY = abi.encodePacked(hex"04", bytes32(uint256(1)), bytes32(uint256(2)));

    uint64 constant QUALITY_WINDOW = 90;
    uint64 constant DELIVER_TIMEOUT = 180;
    uint64 constant ARBITER_TIMEOUT = 600;

    // Money-table symbols (SPEC §4): P = price, B = 2P, D = ceil(P/2), F = 0.02P
    uint256 constant P = 0.001 ether;
    uint256 constant B = 2 * P;
    uint256 constant D = (P + 1) / 2;
    uint256 constant F = P * 200 / 10_000;

    uint64 constant T0 = 1_800_000_000; // arbitrary "now" so expiresAt/resolveBy are in the future
    uint256 nonce; // makes every contentHash unique

    function setUp() public {
        vm.warp(T0);
        b = new Undercloud(arbiter, PUBKEY, "claude-opus-5", keccak256("rubric"), QUALITY_WINDOW, DELIVER_TIMEOUT, ARBITER_TIMEOUT);
        vm.deal(seller, 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(rando, 1 ether);
    }

    // ------------------------------------------------------------------ invariant I1

    /// @dev I1: expected contract balance derived purely from public listing state, plus every payout
    ///      that was deferred to the pull ledger (`owed`) because a payee rejected ETH. Only EOAs take
    ///      part here, so Σ owed is always 0 in this file; Audit.t.sol exercises the deferred path.
    function _expectedBalance() internal view returns (uint256 total) {
        uint256 n = b.listingCount();
        for (uint256 i = 0; i < n; i++) {
            Undercloud.Listing memory L = b.getListing(i);
            if (!L.bondWithdrawn) total += L.bond;
            bool escrowed = L.status == Undercloud.Status.Paid || L.status == Undercloud.Status.Delivered
                || (L.status == Undercloud.Status.Disputed && !L.afterRelease);
            if (escrowed) total += L.price;
            if (L.status == Undercloud.Status.Disputed) total += L.disputeBond;
        }
        total += b.owed(seller) + b.owed(buyer) + b.owed(rando) + b.owed(arbiter) + b.owed(BURN);
    }

    function _assertI1() internal view {
        assertEq(address(b).balance, _expectedBalance(), "I1: contract balance != sum of escrowed value");
    }

    // ------------------------------------------------------------------ helpers

    function _hash() internal returns (bytes32) {
        return keccak256(abi.encode("content", nonce++));
    }

    /// @dev Lists with expiresAt = now + 180 and resolveBy = now + 240 (demo timing from SPEC §5.4).
    function _list(uint256 price) internal returns (uint256 id) {
        bytes32 h = _hash();
        uint8 all = b.ATTEST_ALL();
        vm.prank(seller); // NOTE: prank applies to the next external call only, so no view calls in between
        id = b.list{value: 2 * price}(
            h, Undercloud.Category.CapacityRelease, uint96(price),
            uint64(block.timestamp + 180), uint64(block.timestamp + 240), all, "label"
        );
        _assertI1();
    }

    function _buy(uint256 id) internal {
        uint256 price = b.getListing(id).price;
        vm.prank(buyer);
        b.buy{value: price}(id, PUBKEY);
        _assertI1();
    }

    function _deliver(uint256 id) internal {
        vm.prank(seller);
        b.deliver(id, hex"c1c1c1c1");
        _assertI1();
    }

    function _dispute(uint256 id, Undercloud.Reason reason) internal {
        uint256 dBond = b.disputeBondOf(id);
        vm.prank(buyer);
        b.dispute{value: dBond}(id, reason, hex"5ea1ed", "evidence");
        _assertI1();
    }

    /// @dev list → buy → deliver → warp past the quality window → release. Returns the id.
    function _released(uint256 price) internal returns (uint256 id) {
        id = _list(price);
        _buy(id);
        _deliver(id);
        vm.warp(block.timestamp + QUALITY_WINDOW);
        vm.prank(rando);
        b.release(id);
        _assertI1();
    }

    function _status(uint256 id) internal view returns (Undercloud.Status) {
        return b.getListing(id).status;
    }

    /// @dev The auto-generated getter returns 9 values; decoding the raw return data into the struct
    ///      (same ABI layout) avoids a stack-too-deep in the legacy codegen.
    function _sellerRep(address a) internal view returns (Undercloud.SellerRep memory r) {
        (bool ok, bytes memory data) = address(b).staticcall(abi.encodeWithSelector(b.sellerRep.selector, a));
        require(ok, "sellerRep getter failed");
        r = abi.decode(data, (Undercloud.SellerRep));
    }

    function _buyerRep(address a) internal view returns (Undercloud.BuyerRep memory r) {
        (r.bought, r.disputesFiled, r.disputesLost) = b.buyerRep(a);
    }

    // ================================================================== 1
    function test_List_RequiresExactBondAllAttestationsAndTiming() public {
        bytes32 h = _hash();
        uint64 expiresAt = uint64(block.timestamp + 180);
        uint64 resolveBy = uint64(block.timestamp + 240);
        uint8 all = b.ATTEST_ALL();
        uint8 notSynthetic = all ^ b.ATTEST_SYNTHETIC();
        string memory tooLong = string(new bytes(b.MAX_LABEL_BYTES() + 1));
        Undercloud.Category cat = Undercloud.Category.NewSupply;

        // wrong bond (price instead of 2x price)
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.list{value: P}(h, cat, uint96(P), expiresAt, resolveBy, all, "label");
        // zero price
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.list{value: 0}(h, cat, 0, expiresAt, resolveBy, all, "label");
        // missing attestation bit (everything except SYNTHETIC)
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadAttestation.selector);
        b.list{value: B}(h, cat, uint96(P), expiresAt, resolveBy, notSynthetic, "label");
        // expiresAt <= now
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadTiming.selector);
        b.list{value: B}(h, cat, uint96(P), uint64(block.timestamp), resolveBy, all, "label");
        // resolveBy <= expiresAt
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadTiming.selector);
        b.list{value: B}(h, cat, uint96(P), expiresAt, expiresAt, all, "label");
        // empty label
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadLabel.selector);
        b.list{value: B}(h, cat, uint96(P), expiresAt, resolveBy, all, "");
        // oversized label
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadLabel.selector);
        b.list{value: B}(h, cat, uint96(P), expiresAt, resolveBy, all, tooLong);
        assertEq(b.listingCount(), 0);
        _assertI1();

        // happy path
        uint256 sellerBefore = seller.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Listed(0, seller, cat, h, uint96(P), uint96(B), expiresAt, resolveBy, "label");
        vm.prank(seller);
        uint256 id = b.list{value: B}(h, cat, uint96(P), expiresAt, resolveBy, all, "label");
        assertEq(id, 0);
        assertEq(b.listingCount(), 1);
        assertEq(seller.balance, sellerBefore - B);
        Undercloud.Listing memory L = b.getListing(0);
        assertEq(L.seller, seller);
        assertEq(L.price, P);
        assertEq(L.bond, B);
        assertEq(L.contentHash, h);
        assertTrue(L.status == Undercloud.Status.Listed);
        assertEq(L.listedAt, block.timestamp);
        assertEq(L.expiresAt, expiresAt);
        assertEq(L.resolveBy, resolveBy);
        assertTrue(b.usedContentHash(h));
        assertEq(_sellerRep(seller).listed, 1);
        _assertI1();
    }

    // ================================================================== 2
    function test_List_RejectsDuplicateContentHash() public {
        bytes32 h = _hash();
        uint64 expiresAt = uint64(block.timestamp + 180);
        uint64 resolveBy = uint64(block.timestamp + 240);
        vm.prank(seller);
        b.list{value: B}(h, Undercloud.Category.PriceMove, uint96(P), expiresAt, resolveBy, 15, "label");
        _assertI1();
        // same hash, same seller
        vm.prank(seller);
        vm.expectRevert(Undercloud.DuplicateContent.selector);
        b.list{value: B}(h, Undercloud.Category.PriceMove, uint96(P), expiresAt, resolveBy, 15, "label");
        // same hash, different seller / different price - still rejected (I2: a hash is accepted once, ever)
        vm.deal(rando, 10 ether);
        vm.prank(rando);
        vm.expectRevert(Undercloud.DuplicateContent.selector);
        b.list{value: 4 * P}(h, Undercloud.Category.CapacityRelease, uint96(2 * P), expiresAt, resolveBy, 15, "other");
        // even after the original is delisted
        vm.prank(seller);
        b.delist(0);
        vm.prank(seller);
        vm.expectRevert(Undercloud.DuplicateContent.selector);
        b.list{value: B}(h, Undercloud.Category.PriceMove, uint96(P), expiresAt, resolveBy, 15, "label");
        assertEq(b.listingCount(), 1);
        _assertI1();
    }

    // ================================================================== 3
    function test_Buy_ExactPrice_NotSeller_Valid65BytePubkey_BeforeExpiry() public {
        uint256 id = _list(P);

        // 64-byte key
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadKey.selector);
        b.buy{value: P}(id, new bytes(64));
        // 65 bytes but compressed prefix 0x02
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadKey.selector);
        b.buy{value: P}(id, abi.encodePacked(hex"02", bytes32(uint256(1)), bytes32(uint256(2))));
        // seller buying its own listing
        vm.prank(seller);
        vm.expectRevert(Undercloud.SelfDeal.selector);
        b.buy{value: P}(id, PUBKEY);
        // wrong value (over and under)
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.buy{value: P - 1}(id, PUBKEY);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.buy{value: P + 1}(id, PUBKEY);
        assertTrue(_status(id) == Undercloud.Status.Listed);
        _assertI1();

        // happy path
        uint256 buyerBefore = buyer.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Purchased(id, buyer, PUBKEY);
        _buy(id);
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Paid);
        assertEq(L.buyer, buyer);
        assertEq(L.paidAt, block.timestamp);
        assertEq(buyer.balance, buyerBefore - P);
        assertEq(_buyerRep(buyer).bought, 1);
        assertEq(_sellerRep(seller).sold, 1);

        // a second buyer cannot buy a Paid listing (one buyer per listing, I2)
        vm.prank(rando);
        vm.expectRevert(Undercloud.BadState.selector);
        b.buy{value: P}(id, PUBKEY);

        // after expiry
        uint256 id2 = _list(P);
        vm.warp(b.getListing(id2).expiresAt);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowClosed.selector);
        b.buy{value: P}(id2, PUBKEY);
        assertTrue(_status(id2) == Undercloud.Status.Listed);
        _assertI1();
    }

    // ================================================================== 4
    function test_HappyPath_Release_PaysSellerMinusFee_BondLockedUntilResolveBy() public {
        uint256 id = _list(P);
        _buy(id);

        // deliver: only from Paid, non-empty ciphertext, emits Delivered
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.deliver(id, "");
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Delivered(id, hex"c1c1c1c1");
        _deliver(id);
        assertTrue(_status(id) == Undercloud.Status.Delivered);
        assertEq(b.getListing(id).deliveredAt, block.timestamp);
        // cannot deliver twice
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.deliver(id, hex"c1c1c1c1");

        // release is blocked while the quality window is open
        vm.prank(rando);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.release(id);
        vm.warp(block.timestamp + QUALITY_WINDOW - 1);
        vm.prank(rando);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.release(id);
        _assertI1();

        // release by anyone at deliveredAt + qualityWindow: seller gets P - F, BURN gets F
        vm.warp(block.timestamp + 1);
        uint256 sellerBefore = seller.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Released(id, P - F, F);
        vm.prank(rando);
        b.release(id);
        _assertI1();
        assertEq(seller.balance - sellerBefore, P - F, "seller gets 0.98P");
        assertEq(BURN.balance - burnBefore, F, "burn gets 0.02P");
        assertEq(seller.balance - sellerBefore, P * 98 / 100);
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Released);
        assertEq(L.bond, B, "bond still held");
        assertFalse(L.bondWithdrawn);
        assertEq(_sellerRep(seller).settled, 1);
        assertEq(_sellerRep(seller).volume, P);
        // cannot release twice
        vm.prank(rando);
        vm.expectRevert(Undercloud.BadState.selector);
        b.release(id);

        // bond locked until resolveBy (I4)
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.withdrawBond(id);
        vm.warp(L.resolveBy - 1);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.withdrawBond(id);
        _assertI1();

        // attest: buyer only, once
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Attested(id, "synthetic://priceboard/us-east/h100-on-demand/2026-11-02");
        vm.prank(buyer);
        b.attest(id, "synthetic://priceboard/us-east/h100-on-demand/2026-11-02");
        _assertI1();
        assertTrue(b.getListing(id).confirmed);
        assertEq(_sellerRep(seller).confirmed, 1);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadState.selector);
        b.attest(id, "again");
        assertEq(_sellerRep(seller).confirmed, 1);

        // at resolveBy the bond (B) goes back to the seller; anyone may trigger it
        vm.warp(L.resolveBy);
        sellerBefore = seller.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.BondWithdrawn(id, B);
        vm.prank(rando);
        b.withdrawBond(id);
        _assertI1();
        assertEq(seller.balance - sellerBefore, B, "seller gets B after resolveBy");
        L = b.getListing(id);
        assertEq(L.bond, 0);
        assertTrue(L.bondWithdrawn);
        assertTrue(L.status == Undercloud.Status.Released);
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.withdrawBond(id);
        assertEq(address(b).balance, 0);
        _assertI1();
    }

    // ================================================================== 5
    function test_QualityDispute_BuyerWins_MoneyTable() public {
        uint256 id = _list(P);
        _buy(id);
        _deliver(id);

        uint256 buyerBefore = buyer.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Disputed(id, buyer, Undercloud.Reason.NotAsLabeled, false, hex"5ea1ed", "evidence");
        _dispute(id, Undercloud.Reason.NotAsLabeled);
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Disputed);
        assertFalse(L.afterRelease);
        assertEq(L.disputeBond, D);
        assertEq(L.disputedAt, block.timestamp);
        assertEq(buyerBefore - buyer.balance, D, "buyer posts D");
        assertEq(_buyerRep(buyer).disputesFiled, 1);
        // Disputed listings cannot be released or delivered around the arbiter
        vm.prank(rando);
        vm.expectRevert(Undercloud.BadState.selector);
        b.release(id);

        // rule for the buyer: buyer gets P + D + P/2, BURN gets 1.5P, seller gets nothing
        buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Ruled(id, true, "{\"ground\":\"NotAsLabeled\"}", P + D + P / 2, 0, 3 * P / 2);
        vm.prank(arbiter);
        b.rule(id, true, "{\"ground\":\"NotAsLabeled\"}");
        _assertI1();
        assertEq(buyer.balance - buyerBefore, P + D + P / 2, "buyer: refund + dispute bond + damages");
        assertEq(seller.balance, sellerBefore, "seller gets nothing");
        assertEq(BURN.balance - burnBefore, 3 * P / 2, "1.5P burned");
        L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.RuledBuyer);
        assertEq(L.bond, 0);
        assertEq(L.disputeBond, 0);
        assertTrue(L.bondWithdrawn);
        assertEq(_sellerRep(seller).refuted, 1);
        assertEq(_sellerRep(seller).settled, 0);
        assertEq(_buyerRep(buyer).disputesLost, 0);
        assertEq(address(b).balance, 0, "every wei left the contract");
        // nothing more to withdraw or rule
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.withdrawBond(id);
        vm.prank(arbiter);
        vm.expectRevert(Undercloud.BadState.selector);
        b.rule(id, true, "");
        _assertI1();
    }

    // ================================================================== 6
    function test_QualityDispute_SellerWins_BondStaysLocked() public {
        uint256 id = _list(P);
        _buy(id);
        _deliver(id);
        _dispute(id, Undercloud.Reason.Incoherent);

        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Ruled(id, false, "reasons", 0, P - F + D, F);
        vm.prank(arbiter);
        b.rule(id, false, "reasons");
        _assertI1();
        assertEq(seller.balance - sellerBefore, P - F + D, "seller: price - fee + dispute bond");
        assertEq(buyer.balance, buyerBefore, "buyer gets nothing");
        assertEq(BURN.balance - burnBefore, F, "fee burned");
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.RuledSeller);
        assertEq(L.bond, B, "bond still locked");
        assertEq(L.disputeBond, 0);
        assertFalse(L.bondWithdrawn);
        assertEq(_sellerRep(seller).disputesWon, 1);
        assertEq(_sellerRep(seller).settled, 1);
        assertEq(_sellerRep(seller).volume, P);
        assertEq(_sellerRep(seller).refuted, 0);
        assertEq(_buyerRep(buyer).disputesLost, 1);

        // bond locked until resolveBy (I4)
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.withdrawBond(id);
        vm.warp(L.resolveBy - 1);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.withdrawBond(id);
        _assertI1();

        // buyer may still attest from RuledSeller (it lost, the claim may still come true)
        vm.prank(buyer);
        b.attest(id, "synthetic://press/later");
        _assertI1();
        assertEq(_sellerRep(seller).confirmed, 1);

        vm.warp(L.resolveBy);
        sellerBefore = seller.balance;
        vm.prank(seller);
        b.withdrawBond(id);
        _assertI1();
        assertEq(seller.balance - sellerBefore, B, "B after resolveBy");
        assertEq(address(b).balance, 0);
    }

    // ================================================================== 7
    function test_OutcomeDispute_AfterRelease_BuyerWins_RefundFromBond() public {
        uint256 id = _released(P);
        uint256 sellerAfterRelease = seller.balance;
        assertTrue(_status(id) == Undercloud.Status.Released);

        // outcome dispute: DidNotHappen, before resolveBy, dispute bond D
        uint256 buyerBefore = buyer.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Disputed(id, buyer, Undercloud.Reason.DidNotHappen, true, hex"5ea1ed", "evidence");
        _dispute(id, Undercloud.Reason.DidNotHappen);
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Disputed);
        assertTrue(L.afterRelease);
        assertEq(buyerBefore - buyer.balance, D);
        assertEq(address(b).balance, B + D, "escrow = bond + dispute bond (price already released)");

        // rule for the buyer: P + D + P/2 to the buyer, all from the bond; 0.5P burned
        buyerBefore = buyer.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Ruled(id, true, "reasons", P + D + P / 2, 0, P / 2);
        vm.prank(arbiter);
        b.rule(id, true, "reasons");
        _assertI1();
        assertEq(buyer.balance - buyerBefore, P + D + P / 2, "buyer: refund + dispute bond + damages, from bond");
        assertEq(BURN.balance - burnBefore, P / 2, "0.5P burned");
        assertEq(seller.balance, sellerAfterRelease, "seller keeps P - F from release, nothing more");
        L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.RuledBuyer);
        assertEq(L.bond, 0);
        assertTrue(L.bondWithdrawn);
        assertEq(_sellerRep(seller).refuted, 1);
        assertEq(_sellerRep(seller).settled, 1, "settled stays");
        assertEq(address(b).balance, 0);
    }

    // ================================================================== 8
    function test_Dispute_Rejects_WrongReasonPerPhase_AndAfterResolveBy() public {
        uint256 id = _list(P);
        _buy(id);

        // no dispute while merely Paid (nothing delivered yet)
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadState.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsCommitted, hex"5ea1ed", "e");

        _deliver(id);
        // wrong dispute bond (under and over)
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.dispute{value: D - 1}(id, Undercloud.Reason.NotAsLabeled, hex"5ea1ed", "e");
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.dispute{value: D + 1}(id, Undercloud.Reason.NotAsLabeled, hex"5ea1ed", "e");
        // empty sealed key / oversized evidence
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsLabeled, "", "e");
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadValue.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsLabeled, hex"5ea1ed", string(new bytes(513)));
        // DidNotHappen is not a quality reason
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadReason.selector);
        b.dispute{value: D}(id, Undercloud.Reason.DidNotHappen, hex"5ea1ed", "e");
        assertTrue(_status(id) == Undercloud.Status.Delivered);
        _assertI1();

        // quality window closed but not yet released: any dispute reverts WindowClosed
        vm.warp(block.timestamp + QUALITY_WINDOW);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowClosed.selector);
        b.dispute{value: D}(id, Undercloud.Reason.AlreadyPublic, hex"5ea1ed", "e");

        // after release only DidNotHappen is allowed
        vm.prank(rando);
        b.release(id);
        _assertI1();
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadReason.selector);
        b.dispute{value: D}(id, Undercloud.Reason.AlreadyPublic, hex"5ea1ed", "e");
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadReason.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsCommitted, hex"5ea1ed", "e");

        // DidNotHappen at/after resolveBy: WindowClosed
        vm.warp(b.getListing(id).resolveBy);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowClosed.selector);
        b.dispute{value: D}(id, Undercloud.Reason.DidNotHappen, hex"5ea1ed", "e");
        assertTrue(_status(id) == Undercloud.Status.Released);
        assertEq(_buyerRep(buyer).disputesFiled, 0);
        _assertI1();

        // sanity: DidNotHappen one second before resolveBy is accepted
        uint256 id2 = _released(P);
        vm.warp(b.getListing(id2).resolveBy - 1);
        _dispute(id2, Undercloud.Reason.DidNotHappen);
        assertTrue(_status(id2) == Undercloud.Status.Disputed);
        assertTrue(b.getListing(id2).afterRelease);
    }

    // ================================================================== 9
    function test_RefundUndelivered_AfterTimeout_TenPercentPenalty() public {
        uint256 id = _list(P);
        // refund only from Paid
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadState.selector);
        b.refundUndelivered(id);
        _buy(id);

        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.refundUndelivered(id);
        vm.warp(block.timestamp + DELIVER_TIMEOUT - 1);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.refundUndelivered(id);
        _assertI1();

        vm.warp(block.timestamp + 1);
        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Refunded(id, P + B / 10, B - B / 10);
        vm.prank(rando); // anyone may trigger it
        b.refundUndelivered(id);
        _assertI1();
        assertEq(buyer.balance - buyerBefore, P + B / 10, "buyer: price + 10% of bond");
        assertEq(seller.balance - sellerBefore, B - B / 10, "seller: 90% of bond");
        assertEq(BURN.balance, burnBefore, "nothing burned");
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Refunded);
        assertEq(L.bond, 0);
        assertTrue(L.bondWithdrawn);
        assertEq(_sellerRep(seller).ghosted, 1);
        assertEq(address(b).balance, 0);
        // the ghost can no longer deliver
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.deliver(id, hex"c1c1c1c1");
    }

    // ================================================================== 9b (audit fix)
    /// @dev A seller cannot front-run refundUndelivered with a late delivery: deliver() is closed at
    ///      exactly paidAt + deliverTimeout, the same second the refund opens.
    function test_Deliver_RevertsAtDeliverTimeout() public {
        uint256 id = _list(P);
        _buy(id);
        uint64 paidAt = b.getListing(id).paidAt;
        vm.warp(paidAt + DELIVER_TIMEOUT - 1);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector); // refund not yet open …
        b.refundUndelivered(id);
        vm.warp(paidAt + DELIVER_TIMEOUT);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowClosed.selector); // … and delivery is now closed
        b.deliver(id, hex"c1c1c1c1");
        assertTrue(_status(id) == Undercloud.Status.Paid);
        _assertI1();
        vm.prank(rando);
        b.refundUndelivered(id); // the buyer's free refund still lands
        assertTrue(_status(id) == Undercloud.Status.Refunded);
        _assertI1();
        // and a delivery one second before the deadline is still fine
        uint256 id2 = _list(P);
        _buy(id2);
        vm.warp(b.getListing(id2).paidAt + DELIVER_TIMEOUT - 1);
        _deliver(id2);
        assertTrue(_status(id2) == Undercloud.Status.Delivered);
    }

    // ================================================================== 10
    function test_TimeoutDispute_SplitsEscrow_ReturnsBond() public {
        uint256 id = _list(P);
        _buy(id);
        _deliver(id);
        _dispute(id, Undercloud.Reason.AlreadyPublic);

        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.timeoutDispute(id);
        vm.warp(block.timestamp + ARBITER_TIMEOUT - 1);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.timeoutDispute(id);
        _assertI1();

        vm.warp(block.timestamp + 1);
        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Unadjudicated(id, D + P / 2, (P - P / 2) + B);
        vm.prank(rando); // anyone may trigger it
        b.timeoutDispute(id);
        _assertI1();
        assertEq(buyer.balance - buyerBefore, D + P / 2, "buyer: dispute bond + half the price");
        assertEq(seller.balance - sellerBefore, (P - P / 2) + B, "seller: other half + full bond");
        assertEq(BURN.balance, burnBefore, "nothing burned");
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Unadjudicated);
        assertEq(L.bond, 0);
        assertEq(L.disputeBond, 0);
        assertTrue(L.bondWithdrawn);
        assertEq(_sellerRep(seller).unadjudicated, 1);
        assertEq(_sellerRep(seller).refuted, 0, "silence is not a loss");
        assertEq(_sellerRep(seller).disputesWon, 0, "silence is not a win");
        assertEq(_buyerRep(buyer).disputesLost, 0);
        assertEq(address(b).balance, 0);
        // the arbiter can no longer rule
        vm.prank(arbiter);
        vm.expectRevert(Undercloud.BadState.selector);
        b.rule(id, true, "");
    }

    // ================================================================== 11
    function test_CommitmentVector_MatchesViem() public pure {
        address s = 0x1111111111111111111111111111111111111111;
        string memory canon = '{"claim":"x","v":1}';
        bytes32 salt = 0x2222222222222222222222222222222222222222222222222222222222222222;
        assertEq(
            keccak256(abi.encode(s, canon, salt)),
            0x1d382ab8b84cb3fefe01b6f742503ca354b5bb166120a62a0eb716bd6900b7c8,
            "commitment must match viem encodeAbiParameters([address,string,bytes32])"
        );
    }

    // ================================================================== 12
    function test_AccessControl_Reverts() public {
        uint256 id = _list(P);

        // delist by non-seller
        vm.prank(rando);
        vm.expectRevert(Undercloud.NotSeller.selector);
        b.delist(id);
        vm.prank(buyer);
        vm.expectRevert(Undercloud.NotSeller.selector);
        b.delist(id);

        _buy(id);
        // deliver by non-seller (including the buyer)
        vm.prank(rando);
        vm.expectRevert(Undercloud.NotSeller.selector);
        b.deliver(id, hex"c1c1c1c1");
        vm.prank(buyer);
        vm.expectRevert(Undercloud.NotSeller.selector);
        b.deliver(id, hex"c1c1c1c1");

        _deliver(id);
        // dispute by non-buyer (including the seller)
        vm.deal(rando, 1 ether);
        vm.prank(rando);
        vm.expectRevert(Undercloud.NotBuyer.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsLabeled, hex"5ea1ed", "e");
        vm.prank(seller);
        vm.expectRevert(Undercloud.NotBuyer.selector);
        b.dispute{value: D}(id, Undercloud.Reason.NotAsLabeled, hex"5ea1ed", "e");

        _dispute(id, Undercloud.Reason.NotAsLabeled);
        // rule by non-arbiter (including both parties)
        vm.prank(rando);
        vm.expectRevert(Undercloud.NotArbiter.selector);
        b.rule(id, true, "");
        vm.prank(seller);
        vm.expectRevert(Undercloud.NotArbiter.selector);
        b.rule(id, false, "");
        vm.prank(buyer);
        vm.expectRevert(Undercloud.NotArbiter.selector);
        b.rule(id, true, "");

        vm.prank(arbiter);
        b.rule(id, false, "");
        _assertI1();
        // attest by non-buyer
        vm.prank(rando);
        vm.expectRevert(Undercloud.NotBuyer.selector);
        b.attest(id, "x");
        vm.prank(seller);
        vm.expectRevert(Undercloud.NotBuyer.selector);
        b.attest(id, "x");
        // the state never moved because of a rejected call
        assertTrue(_status(id) == Undercloud.Status.RuledSeller);
        assertFalse(b.getListing(id).confirmed);
        _assertI1();
    }

    // ================================================================== 13
    function test_Delist_ReturnsBond_OnlyWhileListed() public {
        uint256 id = _list(P);
        uint256 sellerBefore = seller.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Delisted(id, B);
        vm.prank(seller);
        b.delist(id);
        _assertI1();
        assertEq(seller.balance - sellerBefore, B, "full bond back");
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.Delisted);
        assertEq(L.bond, 0);
        assertTrue(L.bondWithdrawn);
        assertEq(address(b).balance, 0);
        // not twice
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.delist(id);
        // nobody can buy a delisted listing
        vm.prank(buyer);
        vm.expectRevert(Undercloud.BadState.selector);
        b.buy{value: P}(id, PUBKEY);

        // once bought, the seller can no longer pull the bond
        uint256 id2 = _list(P);
        _buy(id2);
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.delist(id2);
        _deliver(id2);
        vm.prank(seller);
        vm.expectRevert(Undercloud.BadState.selector);
        b.delist(id2);
        assertTrue(_status(id2) == Undercloud.Status.Delivered);
        _assertI1();
    }

    // ================================================================== extra money-table rows

    /// @dev Row "RuledSeller (outcome)": seller gets D now, B after resolveBy, nothing burned.
    function test_OutcomeDispute_SellerWins_GetsDisputeBondOnly() public {
        uint256 id = _released(P);
        _dispute(id, Undercloud.Reason.DidNotHappen);
        uint256 sellerBefore = seller.balance;
        uint256 buyerBefore = buyer.balance;
        uint256 burnBefore = BURN.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Ruled(id, false, "reasons", 0, D, 0);
        vm.prank(arbiter);
        b.rule(id, false, "reasons");
        _assertI1();
        assertEq(seller.balance - sellerBefore, D, "seller: dispute bond only (price already paid)");
        assertEq(buyer.balance, buyerBefore);
        assertEq(BURN.balance, burnBefore, "no second fee");
        Undercloud.Listing memory L = b.getListing(id);
        assertTrue(L.status == Undercloud.Status.RuledSeller);
        assertEq(L.bond, B);
        assertEq(_sellerRep(seller).disputesWon, 1);
        assertEq(_sellerRep(seller).settled, 1, "settled not double counted");
        assertEq(_sellerRep(seller).volume, P, "volume not double counted");
        assertEq(_buyerRep(buyer).disputesLost, 1);
        vm.prank(seller);
        vm.expectRevert(Undercloud.WindowOpen.selector);
        b.withdrawBond(id);
        vm.warp(L.resolveBy);
        sellerBefore = seller.balance;
        vm.prank(seller);
        b.withdrawBond(id);
        _assertI1();
        assertEq(seller.balance - sellerBefore, B);
        assertEq(address(b).balance, 0);
    }

    /// @dev Row "Unadjudicated (outcome)": buyer gets D back, seller gets B back, nothing else moves.
    function test_TimeoutDispute_Outcome_ReturnsDisputeBondAndBond() public {
        uint256 id = _released(P);
        _dispute(id, Undercloud.Reason.DidNotHappen);
        vm.warp(block.timestamp + ARBITER_TIMEOUT);
        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        vm.expectEmit(true, true, true, true, address(b));
        emit Undercloud.Unadjudicated(id, D, B);
        vm.prank(rando);
        b.timeoutDispute(id);
        _assertI1();
        assertEq(buyer.balance - buyerBefore, D);
        assertEq(seller.balance - sellerBefore, B);
        assertTrue(_status(id) == Undercloud.Status.Unadjudicated);
        assertEq(_sellerRep(seller).unadjudicated, 1);
        assertEq(address(b).balance, 0);
    }

    /// @dev Constructor guards: bad arbiter key / zero windows.
    function test_Constructor_RejectsBadKeyAndZeroWindows() public {
        vm.expectRevert(Undercloud.BadKey.selector);
        new Undercloud(address(0), PUBKEY, "m", bytes32(0), 1, 1, 1);
        vm.expectRevert(Undercloud.BadKey.selector);
        new Undercloud(arbiter, new bytes(64), "m", bytes32(0), 1, 1, 1);
        vm.expectRevert(Undercloud.BadKey.selector);
        new Undercloud(arbiter, abi.encodePacked(hex"02", bytes32(0), bytes32(0)), "m", bytes32(0), 1, 1, 1);
        vm.expectRevert(Undercloud.BadTiming.selector);
        new Undercloud(arbiter, PUBKEY, "m", bytes32(0), 0, 1, 1);
        vm.expectRevert(Undercloud.BadTiming.selector);
        new Undercloud(arbiter, PUBKEY, "m", bytes32(0), 1, 0, 1);
        vm.expectRevert(Undercloud.BadTiming.selector);
        new Undercloud(arbiter, PUBKEY, "m", bytes32(0), 1, 1, 0);
        // the deployed instance carries the committed judge parameters
        assertEq(b.arbiter(), arbiter);
        assertEq(b.arbiterPubKey(), PUBKEY);
        assertEq(b.arbiterModelId(), "claude-opus-5");
        assertEq(b.rubricHash(), keccak256("rubric"));
        assertEq(b.qualityWindow(), QUALITY_WINDOW);
        assertEq(b.deliverTimeout(), DELIVER_TIMEOUT);
        assertEq(b.arbiterTimeout(), ARBITER_TIMEOUT);
    }

    // ================================================================== fuzz

    /// @dev I1 holds through the whole happy path for any price in [1, 1 ETH]; seller ends with
    ///      P - F + B, BURN with F, buyer down exactly P (I3 for this path).
    function testFuzz_HappyPath_I1(uint96 price) public {
        uint256 p = bound(uint256(price), 1, 1e18);
        uint256 fee = p * 200 / 10_000;
        uint256 sellerStart = seller.balance;
        uint256 buyerStart = buyer.balance;
        uint256 burnStart = BURN.balance;

        uint256 id = _list(p); // _assertI1 inside
        assertEq(b.requiredBond(p), 2 * p);
        _buy(id);
        _deliver(id);
        vm.warp(block.timestamp + QUALITY_WINDOW);
        vm.prank(rando);
        b.release(id);
        _assertI1();
        assertEq(seller.balance, sellerStart - 2 * p + (p - fee));
        assertEq(BURN.balance - burnStart, fee);

        vm.warp(b.getListing(id).resolveBy);
        vm.prank(rando);
        b.withdrawBond(id);
        _assertI1();
        assertEq(seller.balance, sellerStart + p - fee, "seller nets P - F");
        assertEq(buyer.balance, buyerStart - p, "buyer paid exactly P");
        assertEq(BURN.balance - burnStart, fee);
        assertEq(address(b).balance, 0);
    }

    /// @dev I3 (conservation) for both quality-dispute rulings at any price: every wei of
    ///      P + B + D lands in exactly one of {buyer, seller, BURN}, and I1 holds throughout.
    function testFuzz_QualityDispute_ConservesValue(uint96 price, bool buyerWins) public {
        uint256 p = bound(uint256(price), 1, 1e18);
        uint256 d = (p + 1) / 2;
        uint256 fee = p * 200 / 10_000;
        uint256 sellerStart = seller.balance;
        uint256 buyerStart = buyer.balance;
        uint256 burnStart = BURN.balance;

        uint256 id = _list(p);
        _buy(id);
        _deliver(id);
        _dispute(id, Undercloud.Reason.NotAsLabeled);
        assertEq(address(b).balance, p + 2 * p + d);
        vm.prank(arbiter);
        b.rule(id, buyerWins, "fuzz");
        _assertI1();

        if (buyerWins) {
            assertEq(buyer.balance, buyerStart - p - d + (p + d + p / 2));
            assertEq(seller.balance, sellerStart - 2 * p);
            assertEq(BURN.balance - burnStart, 2 * p - p / 2);
            assertEq(address(b).balance, 0);
        } else {
            assertEq(buyer.balance, buyerStart - p - d);
            assertEq(seller.balance, sellerStart - 2 * p + (p - fee + d));
            assertEq(BURN.balance - burnStart, fee);
            assertEq(address(b).balance, 2 * p, "bond still locked");
            vm.warp(b.getListing(id).resolveBy);
            vm.prank(seller);
            b.withdrawBond(id);
            _assertI1();
            assertEq(address(b).balance, 0);
        }
        // conservation: the three parties' net balance change sums to zero once the contract is empty
        int256 net = int256(buyer.balance) - int256(buyerStart) + int256(seller.balance) - int256(sellerStart)
            + int256(BURN.balance) - int256(burnStart);
        assertEq(net, 0, "I3: no wei created or destroyed");
    }
}
