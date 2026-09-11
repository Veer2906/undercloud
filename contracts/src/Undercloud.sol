// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title Undercloud - a sealed market for compute-capacity intelligence (Arbitrum Sepolia demo).
/// @notice All timing uses block.timestamp (block.number is the L1 block estimate on Arbitrum).
///         Every listing must carry the SYNTHETIC attestation: this deployment cannot list a real provider.
contract Undercloud {
    enum Status { Listed, Paid, Delivered, Released, Disputed, RuledBuyer, RuledSeller, Unadjudicated, Refunded, Delisted }
    enum Category { CapacityRelease, NewSupply, PriceMove, DemandSignal, ProviderReference }
    enum Reason { NotAsCommitted, NotAsLabeled, AlreadyPublic, Incoherent, ForbiddenContent, DidNotHappen }

    struct Listing {
        address seller;
        address buyer;
        uint96  price;
        uint96  bond;          // seller stake still held by the contract
        uint96  disputeBond;   // buyer stake while Disputed
        bytes32 contentHash;   // keccak256(abi.encode(seller, canonicalDossierJson, salt))
        Category category;
        Status  status;
        Reason  reason;
        bool    afterRelease;  // true = outcome dispute (DidNotHappen) filed after Release
        bool    confirmed;     // buyer attested the claim surfaced publicly (display only)
        bool    bondWithdrawn;
        uint64  listedAt;
        uint64  expiresAt;     // no purchases after this
        uint64  resolveBy;     // bond locked until this; outcome disputes allowed until this
        uint64  paidAt;
        uint64  deliveredAt;
        uint64  disputedAt;
    }
    struct SellerRep { uint32 listed; uint32 sold; uint32 settled; uint32 confirmed; uint32 refuted; uint32 disputesWon; uint32 unadjudicated; uint32 ghosted; uint128 volume; }
    struct BuyerRep  { uint32 bought; uint32 disputesFiled; uint32 disputesLost; }

    uint8   public constant ATTEST_NO_NDA = 1;
    uint8   public constant ATTEST_NO_CREDENTIALS = 2;
    uint8   public constant ATTEST_PROVIDER_LEVEL_ONLY = 4;
    uint8   public constant ATTEST_SYNTHETIC = 8;
    uint8   public constant ATTEST_ALL = 15;
    uint256 public constant BOND_MULTIPLIER = 2;
    uint256 public constant FEE_BPS = 200;
    uint256 public constant MAX_LABEL_BYTES = 2048;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address public immutable arbiter;
    bytes32 public immutable rubricHash;
    uint64  public immutable qualityWindow;
    uint64  public immutable deliverTimeout;
    uint64  public immutable arbiterTimeout;
    bytes   public arbiterPubKey;    // 65-byte uncompressed secp256k1 (0x04…); buyers seal dispute keys to it
    string  public arbiterModelId;   // e.g. "claude-opus-5"

    Listing[] private _listings;
    mapping(bytes32 => bool) public usedContentHash;
    mapping(address => SellerRep) public sellerRep;
    mapping(address => BuyerRep)  public buyerRep;
    /// @notice Payouts whose ETH transfer failed (a contract counterparty that rejects ETH) are credited
    ///         here instead of reverting the settlement, so no counterparty can hold a deal hostage by
    ///         refusing payment. The payee pulls with `withdrawOwed()`. Counted in invariant I1.
    mapping(address => uint256) public owed;
    bool private _entered;

    event Listed(uint256 indexed id, address indexed seller, Category category, bytes32 contentHash, uint96 price, uint96 bond, uint64 expiresAt, uint64 resolveBy, string label);
    event Delisted(uint256 indexed id, uint256 bondReturned);
    event Purchased(uint256 indexed id, address indexed buyer, bytes buyerPubKey);
    event Delivered(uint256 indexed id, bytes ciphertext);
    event Released(uint256 indexed id, uint256 sellerPayout, uint256 feeBurned);
    event Refunded(uint256 indexed id, uint256 buyerPayout, uint256 sellerPayout);
    event Disputed(uint256 indexed id, address indexed buyer, Reason reason, bool afterRelease, bytes sealedKey, string evidence);
    event Ruled(uint256 indexed id, bool buyerWins, string reasons, uint256 buyerPayout, uint256 sellerPayout, uint256 burned);
    event Unadjudicated(uint256 indexed id, uint256 buyerPayout, uint256 sellerPayout);
    event Attested(uint256 indexed id, string evidenceURI);
    event BondWithdrawn(uint256 indexed id, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event OwedWithdrawn(address indexed to, uint256 amount);

    error BadValue(); error BadAttestation(); error DuplicateContent(); error BadTiming(); error BadLabel();
    error BadState(); error NotSeller(); error NotBuyer(); error NotArbiter(); error SelfDeal(); error BadKey();
    error WindowOpen(); error WindowClosed(); error BadReason(); error Reentrancy(); error PayFailed();

    modifier nonReentrant() { if (_entered) revert Reentrancy(); _entered = true; _; _entered = false; }

    constructor(address _arbiter, bytes memory _arbiterPubKey, string memory _modelId, bytes32 _rubricHash,
                uint64 _qualityWindow, uint64 _deliverTimeout, uint64 _arbiterTimeout) {
        if (_arbiter == address(0) || _arbiterPubKey.length != 65 || _arbiterPubKey[0] != 0x04) revert BadKey();
        if (_qualityWindow == 0 || _deliverTimeout == 0 || _arbiterTimeout == 0) revert BadTiming();
        arbiter = _arbiter; arbiterPubKey = _arbiterPubKey; arbiterModelId = _modelId; rubricHash = _rubricHash;
        qualityWindow = _qualityWindow; deliverTimeout = _deliverTimeout; arbiterTimeout = _arbiterTimeout;
    }

    // ---------- views ----------
    function listingCount() external view returns (uint256) { return _listings.length; }
    function getListing(uint256 id) external view returns (Listing memory) { return _listings[id]; }
    function requiredBond(uint256 price) public pure returns (uint256) { return price * BOND_MULTIPLIER; }
    function disputeBondOf(uint256 id) public view returns (uint256) { return (uint256(_listings[id].price) + 1) / 2; }

    // ---------- seller ----------
    function list(bytes32 contentHash, Category category, uint96 price, uint64 expiresAt, uint64 resolveBy,
                  uint8 attestations, string calldata label) external payable returns (uint256 id) {
        if (price == 0 || msg.value != requiredBond(price) || msg.value > type(uint96).max) revert BadValue();
        if (attestations != ATTEST_ALL) revert BadAttestation();
        if (usedContentHash[contentHash]) revert DuplicateContent();
        if (expiresAt <= block.timestamp || resolveBy <= expiresAt) revert BadTiming();
        if (bytes(label).length == 0 || bytes(label).length > MAX_LABEL_BYTES) revert BadLabel();
        usedContentHash[contentHash] = true;
        id = _listings.length;
        Listing storage L = _listings.push();
        L.seller = msg.sender; L.price = price; L.bond = uint96(msg.value); L.contentHash = contentHash;
        L.category = category; L.status = Status.Listed; L.listedAt = uint64(block.timestamp);
        L.expiresAt = expiresAt; L.resolveBy = resolveBy;
        sellerRep[msg.sender].listed++;
        emit Listed(id, msg.sender, category, contentHash, price, uint96(msg.value), expiresAt, resolveBy, label);
    }

    function delist(uint256 id) external nonReentrant {
        Listing storage L = _listings[id];
        if (msg.sender != L.seller) revert NotSeller();
        if (L.status != Status.Listed) revert BadState();
        uint256 amount = L.bond;
        L.status = Status.Delisted; L.bond = 0; L.bondWithdrawn = true;
        emit Delisted(id, amount);
        _pay(msg.sender, amount);
    }

    function deliver(uint256 id, bytes calldata ciphertext) external {
        Listing storage L = _listings[id];
        if (msg.sender != L.seller) revert NotSeller();
        if (L.status != Status.Paid) revert BadState();
        // Once the buyer may claim refundUndelivered, a late delivery can no longer pre-empt it.
        if (block.timestamp >= L.paidAt + deliverTimeout) revert WindowClosed();
        if (ciphertext.length == 0) revert BadValue();
        L.status = Status.Delivered; L.deliveredAt = uint64(block.timestamp);
        emit Delivered(id, ciphertext);
    }

    // ---------- buyer ----------
    function buy(uint256 id, bytes calldata buyerPubKey) external payable {
        Listing storage L = _listings[id];
        if (L.status != Status.Listed) revert BadState();
        if (block.timestamp >= L.expiresAt) revert WindowClosed();
        if (msg.sender == L.seller) revert SelfDeal();
        if (msg.value != L.price) revert BadValue();
        if (buyerPubKey.length != 65 || buyerPubKey[0] != 0x04) revert BadKey();
        L.status = Status.Paid; L.buyer = msg.sender; L.paidAt = uint64(block.timestamp);
        buyerRep[msg.sender].bought++; sellerRep[L.seller].sold++;
        emit Purchased(id, msg.sender, buyerPubKey);
    }

    /// @param sealedKey the buyer's one-time private key, ECIES-encrypted to arbiterPubKey (never plaintext)
    /// @param evidence  reason detail or a URI; MUST NOT contain provider or site names (agents enforce; arbiter ignores them)
    function dispute(uint256 id, Reason reason, bytes calldata sealedKey, string calldata evidence) external payable {
        Listing storage L = _listings[id];
        if (msg.sender != L.buyer) revert NotBuyer();
        if (msg.value != disputeBondOf(id)) revert BadValue();
        if (sealedKey.length == 0 || bytes(evidence).length > 512) revert BadValue();
        if (L.status == Status.Delivered) {
            if (block.timestamp >= L.deliveredAt + qualityWindow) revert WindowClosed();
            if (reason == Reason.DidNotHappen) revert BadReason();
            L.afterRelease = false;
        } else if (L.status == Status.Released) {
            if (reason != Reason.DidNotHappen) revert BadReason();
            if (block.timestamp >= L.resolveBy) revert WindowClosed();
            L.afterRelease = true;
        } else {
            revert BadState();
        }
        L.status = Status.Disputed; L.reason = reason; L.disputeBond = uint96(msg.value); L.disputedAt = uint64(block.timestamp);
        buyerRep[msg.sender].disputesFiled++;
        emit Disputed(id, msg.sender, reason, L.afterRelease, sealedKey, evidence);
    }

    function attest(uint256 id, string calldata evidenceURI) external {
        Listing storage L = _listings[id];
        if (msg.sender != L.buyer) revert NotBuyer();
        if (L.status != Status.Released && L.status != Status.RuledSeller) revert BadState();
        if (L.confirmed) revert BadState();
        L.confirmed = true; sellerRep[L.seller].confirmed++;
        emit Attested(id, evidenceURI);
    }

    // ---------- anyone (keeper) ----------
    function release(uint256 id) external nonReentrant {
        Listing storage L = _listings[id];
        if (L.status != Status.Delivered) revert BadState();
        if (block.timestamp < L.deliveredAt + qualityWindow) revert WindowOpen();
        uint256 price = L.price; uint256 fee = price * FEE_BPS / 10_000;
        L.status = Status.Released;
        SellerRep storage R = sellerRep[L.seller]; R.settled++; R.volume += uint128(price);
        emit Released(id, price - fee, fee);
        _pay(L.seller, price - fee); _pay(BURN, fee);
    }

    function refundUndelivered(uint256 id) external nonReentrant {
        Listing storage L = _listings[id];
        if (L.status != Status.Paid) revert BadState();
        if (block.timestamp < L.paidAt + deliverTimeout) revert WindowOpen();
        uint256 bond = L.bond; uint256 penalty = bond / 10;
        uint256 buyerPayout = uint256(L.price) + penalty; uint256 sellerPayout = bond - penalty;
        L.status = Status.Refunded; L.bond = 0; L.bondWithdrawn = true;
        sellerRep[L.seller].ghosted++;
        emit Refunded(id, buyerPayout, sellerPayout);
        _pay(L.buyer, buyerPayout); _pay(L.seller, sellerPayout);
    }

    function timeoutDispute(uint256 id) external nonReentrant {
        Listing storage L = _listings[id];
        if (L.status != Status.Disputed) revert BadState();
        if (block.timestamp < L.disputedAt + arbiterTimeout) revert WindowOpen();
        uint256 price = L.price; uint256 bond = L.bond; uint256 dBond = L.disputeBond;
        uint256 buyerHalf = L.afterRelease ? 0 : price / 2;
        uint256 sellerHalf = L.afterRelease ? 0 : price - buyerHalf;
        uint256 buyerPayout = dBond + buyerHalf; uint256 sellerPayout = sellerHalf + bond;
        L.status = Status.Unadjudicated; L.bond = 0; L.disputeBond = 0; L.bondWithdrawn = true;
        sellerRep[L.seller].unadjudicated++;
        emit Unadjudicated(id, buyerPayout, sellerPayout);
        _pay(L.buyer, buyerPayout); _pay(L.seller, sellerPayout);
    }

    function withdrawBond(uint256 id) external nonReentrant {
        Listing storage L = _listings[id];
        if (L.status != Status.Released && L.status != Status.RuledSeller) revert BadState();
        if (L.bondWithdrawn) revert BadState();
        if (block.timestamp < L.resolveBy) revert WindowOpen();
        uint256 amount = L.bond; L.bond = 0; L.bondWithdrawn = true;
        emit BondWithdrawn(id, amount);
        _pay(L.seller, amount);
    }

    // ---------- arbiter ----------
    /// @param reasons name-redacted JSON: {"model":..,"ground":..,"reasons":[..],"rubricHash":..}
    function rule(uint256 id, bool buyerWins, string calldata reasons) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        Listing storage L = _listings[id];
        if (L.status != Status.Disputed) revert BadState();
        uint256 price = L.price; uint256 bond = L.bond; uint256 dBond = L.disputeBond;
        if (buyerWins) {
            uint256 remainder = bond - (L.afterRelease ? price : 0); // >= price since bond == 2*price
            uint256 damages = price / 2;
            uint256 burned = remainder - damages;
            uint256 buyerPayout = price + dBond + damages;
            L.status = Status.RuledBuyer; L.bond = 0; L.disputeBond = 0; L.bondWithdrawn = true;
            sellerRep[L.seller].refuted++;
            emit Ruled(id, true, reasons, buyerPayout, 0, burned);
            _pay(L.buyer, buyerPayout); _pay(BURN, burned);
        } else {
            uint256 fee = L.afterRelease ? 0 : price * FEE_BPS / 10_000;
            uint256 sellerPayout = dBond + (L.afterRelease ? 0 : price - fee);
            L.status = Status.RuledSeller; L.disputeBond = 0;
            SellerRep storage R = sellerRep[L.seller]; R.disputesWon++;
            if (!L.afterRelease) { R.settled++; R.volume += uint128(price); }
            buyerRep[L.buyer].disputesLost++;
            emit Ruled(id, false, reasons, 0, sellerPayout, fee);
            _pay(L.seller, sellerPayout); if (fee > 0) _pay(BURN, fee);
        }
    }

    // ---------- payments ----------
    /// @notice Pull a payout that could not be pushed (see `owed`). Forwards all gas; reverts if it fails again.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert BadValue();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert PayFailed();
        emit OwedWithdrawn(msg.sender, amount);
    }

    /// @dev Push with a bounded gas stipend (enough for any EOA or a simple receive() hook); on failure
    ///      credit `owed` instead of reverting, so a payee that rejects ETH can never block a settlement
    ///      or lock the counterparty's funds. The bounded stipend also stops a payee from burning the
    ///      caller's gas. State is final before any call (checks-effects-interactions + nonReentrant).
    uint256 private constant PAY_GAS = 100_000;

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: PAY_GAS}("");
        if (!ok) { owed[to] += amount; emit PaymentDeferred(to, amount); }
    }
}
