// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SealedInbox
/// @notice A post-quantum vulnerability-disclosure inbox for QoreChain accounts.
///
/// A project publishes its QoreSeal recipient card here (the card names its ML-KEM-1024 key, registered in
/// the chain's KEM key registry, and its X25519 key, and is signed by the project's ML-DSA-87 key). A
/// reporter encrypts a report to the project with QoreSeal, signs a short drop statement with QoreSign
/// (`signMessage`) and anyone relays the envelope here. The contract
///   1. reads the signer's registered key from the PQC Key Status precompile (0x0a02) and requires an
///      ML-DSA-87 key with a proven possession,
///   2. rebuilds the statement itself (this chain, this inbox, both accounts, SHA-256 of the envelope)
///      and checks the ML-DSA-87 signature with the PQC Verify precompile (0x0a01),
///   3. stores the drop with its block, so the order of reports is public while their content is not.
/// The envelope's authenticated data names the reporter, so a copied envelope claimed by someone else
/// cannot be opened under the copier's name: the project sees which drop is the genuine first one.
/// The project can answer with a receipt signed by its own ML-DSA-87 key.
contract SealedInbox {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_STATUS = 0x0000000000000000000000000000000000000a02;
    uint8 internal constant ML_DSA_87 = 1;
    uint256 public constant MAX_ENVELOPE = 32 * 1024;
    bytes internal constant MESSAGE_DOMAIN = "qorechain-msg-v1|";
    bytes internal constant CARD_TITLE = "QoreSeal recipient card v1";
    bytes internal constant ISSUED_AT = "\nIssued at: ";
    bytes internal constant HEX = "0123456789abcdef";
    bytes internal constant BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    bytes internal constant HRP = "qor";

    struct Drop {
        address reporter;
        address recipient;
        bytes32 envelopeSha256;
        uint64 blockNumber;
        uint64 timestamp;
        uint64 receiptBlock; // 0 until the recipient signs a receipt
        uint32 size;
    }

    /// The chain whose QoreSign messages are accepted (`qorechain-diana` on testnet).
    string public chainId;
    Drop[] internal _drops;
    mapping(address => uint256[]) internal _inbox;
    mapping(address => mapping(bytes32 => bool)) public dropped;
    /// Latest card per account: its "Issued at" (YYYY-MM-DDTHH:MM:SSZ as bytes20) and EVM block.
    mapping(address => bytes20) public cardIssuedAt;
    mapping(address => uint64) public cardBlock;

    event CardPublished(
        address indexed account, bytes20 issuedAt, string cardText, bytes classicalPubKey, bytes classicalSig, bytes pqSig
    );
    event Dropped(
        uint256 indexed id, address indexed recipient, address indexed reporter, bytes32 envelopeSha256, bytes envelope
    );
    event Receipt(uint256 indexed id, address indexed recipient, address indexed reporter);

    error NoPqcKey();
    error NoProofOfPossession();
    error BadSignature();
    error BadCard();
    error NotNewer();
    error EmptyEnvelope();
    error EnvelopeTooLarge();
    error AlreadyDropped();
    error UnknownDrop();
    error AlreadyAcknowledged();

    constructor(string memory chainId_) {
        chainId = chainId_;
    }

    // ── cards ────────────────────────────────────────────────────────────────

    /// @notice Publish `account`'s QoreSeal recipient card. Callable by anyone; only a card that the
    /// account's registered ML-DSA-87 key signed, for this chain and this account, and newer than the
    /// one on record, is accepted. Readers still verify the whole card (both signatures, the ML-KEM key
    /// hash against the registry) with QoreSeal's verifyRecipientCard.
    function publishCard(
        address account,
        string calldata cardText,
        bytes calldata classicalPubKey,
        bytes calldata classicalSig,
        bytes calldata pqSig
    ) external {
        bytes calldata t = bytes(cardText);
        bytes memory head = abi.encodePacked(CARD_TITLE, "\nChain ID: ", chainId, "\nAddress: ", _bech32(account), "\n");
        uint256 tail = ISSUED_AT.length + 20;
        if (t.length < head.length + tail || keccak256(t[0:head.length]) != keccak256(head)) revert BadCard();
        if (keccak256(t[t.length - tail:t.length - 20]) != keccak256(ISSUED_AT)) revert BadCard();
        bytes20 issuedAt = bytes20(t[t.length - 20:]);
        if (uint160(issuedAt) <= uint160(cardIssuedAt[account])) revert NotNewer();
        _requireSigned(account, t, pqSig);
        cardIssuedAt[account] = issuedAt;
        cardBlock[account] = uint64(block.number);
        emit CardPublished(account, issuedAt, cardText, classicalPubKey, classicalSig, pqSig);
    }

    // ── drops ────────────────────────────────────────────────────────────────

    /// @notice Drop a sealed report for `recipient`, signed by `reporter`'s ML-DSA-87 key over
    /// {dropText}. Callable by anyone (a relayer pays the gas; the signature is what counts).
    function drop(address reporter, address recipient, bytes calldata envelope, bytes calldata pqSig)
        external
        returns (uint256 id)
    {
        if (envelope.length == 0) revert EmptyEnvelope();
        if (envelope.length > MAX_ENVELOPE) revert EnvelopeTooLarge();
        bytes32 digest = sha256(envelope);
        if (dropped[reporter][digest]) revert AlreadyDropped();
        _requireSigned(reporter, bytes(dropText(reporter, recipient, digest)), pqSig);
        dropped[reporter][digest] = true;
        id = _drops.length;
        _drops.push(
            Drop({
                reporter: reporter,
                recipient: recipient,
                envelopeSha256: digest,
                blockNumber: uint64(block.number),
                timestamp: uint64(block.timestamp),
                receiptBlock: 0,
                size: uint32(envelope.length)
            })
        );
        _inbox[recipient].push(id);
        emit Dropped(id, recipient, reporter, digest, envelope);
    }

    /// @notice The recipient's receipt for drop `id`, signed by its ML-DSA-87 key over {receiptText}.
    function acknowledge(uint256 id, bytes calldata pqSig) external {
        if (id >= _drops.length) revert UnknownDrop();
        Drop storage d = _drops[id];
        if (d.receiptBlock != 0) revert AlreadyAcknowledged();
        _requireSigned(d.recipient, bytes(receiptText(id)), pqSig);
        d.receiptBlock = uint64(block.number);
        emit Receipt(id, d.recipient, d.reporter);
    }

    // ── statements (what QoreSign signMessage signs; the TS client builds the same text) ─────

    function dropText(address reporter, address recipient, bytes32 digest) public view returns (string memory) {
        return string(
            abi.encodePacked(
                "Sealed Disclosure drop v1\nChain ID: ",
                chainId,
                "\nInbox: ",
                _hex(abi.encodePacked(address(this))),
                "\nFrom: ",
                _bech32(reporter),
                "\nTo: ",
                _bech32(recipient),
                "\nEnvelope SHA-256: ",
                _hex(abi.encodePacked(digest))
            )
        );
    }

    function receiptText(uint256 id) public view returns (string memory) {
        if (id >= _drops.length) revert UnknownDrop();
        Drop storage d = _drops[id];
        return string(
            abi.encodePacked(
                "Sealed Disclosure receipt v1\nChain ID: ",
                chainId,
                "\nInbox: ",
                _hex(abi.encodePacked(address(this))),
                "\nDrop: ",
                _decimal(id),
                "\nFrom: ",
                _bech32(d.reporter),
                "\nTo: ",
                _bech32(d.recipient),
                "\nEnvelope SHA-256: ",
                _hex(abi.encodePacked(d.envelopeSha256))
            )
        );
    }

    // ── reads ────────────────────────────────────────────────────────────────

    function dropCount() external view returns (uint256) {
        return _drops.length;
    }

    function getDrop(uint256 id) external view returns (Drop memory) {
        if (id >= _drops.length) revert UnknownDrop();
        return _drops[id];
    }

    function inboxOf(address recipient) external view returns (uint256[] memory) {
        return _inbox[recipient];
    }

    function qorAddress(address account) external pure returns (string memory) {
        return string(_bech32(account));
    }

    // ── precompiles ──────────────────────────────────────────────────────────

    function _requireSigned(address account, bytes memory text, bytes calldata pqSig) internal view {
        bytes memory pubkey = _provenKey(account);
        bytes memory message = abi.encodePacked(MESSAGE_DOMAIN, chainId, "|", text);
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, pqSig, message));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert BadSignature();
    }

    function _provenKey(address account) internal view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) = PQC_STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        if (!ok || ret.length < 128) revert NoPqcKey();
        bool registered;
        uint8 alg;
        bool proven;
        (registered, alg, pubkey, proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != ML_DSA_87 || pubkey.length == 0) revert NoPqcKey();
        if (!proven) revert NoProofOfPossession();
    }

    // ── encoding ─────────────────────────────────────────────────────────────

    function _hex(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(2 + b.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < b.length; i++) {
            out[2 + 2 * i] = HEX[uint8(b[i]) >> 4];
            out[3 + 2 * i] = HEX[uint8(b[i]) & 15];
        }
    }

    function _decimal(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 n;
        for (uint256 x = v; x != 0; x /= 10) n++;
        out = new bytes(n);
        for (; v != 0; v /= 10) out[--n] = bytes1(uint8(48 + (v % 10)));
    }

    function _polymodStep(uint256 pre) private pure returns (uint256 chk) {
        uint256 b = pre >> 25;
        chk = (pre & 0x1ffffff) << 5;
        if (b & 1 != 0) chk ^= 0x3b6a57b2;
        if (b & 2 != 0) chk ^= 0x26508e6d;
        if (b & 4 != 0) chk ^= 0x1ea119fa;
        if (b & 8 != 0) chk ^= 0x3d4233dd;
        if (b & 16 != 0) chk ^= 0x2a1462b3;
    }

    function _bech32(address account) internal pure returns (bytes memory out) {
        uint256 v = uint160(account);
        uint256[32] memory data; // 160 bits = 32 groups of 5
        for (uint256 i; i < 32; i++) {
            data[31 - i] = (v >> (5 * i)) & 31;
        }
        uint256 chk = 1;
        for (uint256 i; i < HRP.length; i++) chk = _polymodStep(chk) ^ (uint8(HRP[i]) >> 5);
        chk = _polymodStep(chk);
        for (uint256 i; i < HRP.length; i++) chk = _polymodStep(chk) ^ (uint8(HRP[i]) & 31);
        for (uint256 i; i < 32; i++) chk = _polymodStep(chk) ^ data[i];
        for (uint256 i; i < 6; i++) chk = _polymodStep(chk);
        chk ^= 1;

        out = new bytes(HRP.length + 1 + 32 + 6);
        for (uint256 i; i < HRP.length; i++) out[i] = HRP[i];
        uint256 o = HRP.length;
        out[o++] = "1";
        for (uint256 i; i < 32; i++) out[o++] = BECH32_CHARSET[data[i]];
        for (uint256 i; i < 6; i++) out[o++] = BECH32_CHARSET[(chk >> (5 * (5 - i))) & 31];
    }
}
