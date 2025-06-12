const express = require("express");
const fs = require("fs");
const { JsonRpcProvider, isAddress, formatUnits, Wallet, parseUnits } = require("ethers");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors({
    origin: 'http://127.0.0.1:5500'
}));
app.use(express.json());

// Cho phép phục vụ các file tĩnh (HTML, CSS, JS...) trong cùng thư mục
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL;
const GAME_WALLET_ADDRESS = process.env.GAME_WALLET_ADDRESS;
const GAME_WALLET_PRIVATE_KEY = process.env.GAME_WALLET_PRIVATE_KEY;

if (!GAME_WALLET_ADDRESS || !GAME_WALLET_PRIVATE_KEY || !RPC_URL) {
    console.error("Lỗi: Các biến môi trường GAME_WALLET_ADDRESS, GAME_WALLET_PRIVATE_KEY, hoặc RPC_URL không được định nghĩa.");
    process.exit(1);
}

const NATIVE_COIN_DECIMALS = 18;

const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const file = './db.json';
const adapter = new JSONFile(file);
const db = new Low(adapter, { users: {}, processedTxs: {} });

let provider;
let gameWallet;

async function initializeApp() {
    try {
        await db.read();
        await db.write();
        console.log("[Backend] Database đã sẵn sàng.");
        provider = new JsonRpcProvider(RPC_URL);
        gameWallet = new Wallet(GAME_WALLET_PRIVATE_KEY, provider);
        console.log(`[Backend] Wallet game khởi tạo với địa chỉ: ${gameWallet.address}`);

        app.listen(PORT, () => {
            console.log(`[Backend] Server đang chạy trên cổng ${PORT}`);
            console.log(`[Backend] Kết nối với RPC: ${RPC_URL}`);
            console.log(`[Backend] Địa chỉ ví game: ${GAME_WALLET_ADDRESS}`);
        });

    } catch (error) {
        console.error("[Backend] Lỗi nghiêm trọng khi khởi tạo ứng dụng:", error);
        console.error("Vui lòng kiểm tra file .env, kết nối mạng, hoặc quyền ghi/đọc file db.json.");
        process.exit(1);
    }
}

initializeApp();


// --- ROUTES ---

// Lấy số xu cho ví người dùng
app.get("/balance/:wallet", async (req, res) => {
    const userWallet = req.params.wallet.toLowerCase();
    console.log(`[Backend] [BALANCE] Yêu cầu lấy số xu cho ví: ${userWallet}`);
    await db.read();
    console.log("[Backend] [BALANCE] db.data:", JSON.stringify(db.data));
    try {
        if (!db.data || !db.data.users || !(userWallet in db.data.users)) {
            console.log("[Backend] [BALANCE] Không có user này trong db.");
            return res.json({ coins: 0 });
        }
        res.json({ coins: db.data.users[userWallet] });
    } catch (error) {
        console.error("[Backend] [BALANCE] Lỗi khi lấy số dư cho ví:", userWallet, error);
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ khi lấy số dư.", details: error.message });
    }
});


// Xác nhận nạp xu bằng giao dịch blockchain
app.post("/confirm", async (req, res) => {
    const { wallet, txHash } = req.body;
    const userWalletLower = wallet?.toLowerCase();

    console.log(`[Backend] [CONFIRM] Yêu cầu xác nhận giao dịch: ${txHash} từ ví ${userWalletLower}`);
    if (!userWalletLower || !txHash) {
        console.error("[Backend] [CONFIRM] Thiếu thông tin ví hoặc Transaction Hash trong request body.");
        return res.status(400).json({ success: false, error: "Thiếu thông tin ví hoặc Transaction Hash." });
    }

    if (!isAddress(userWalletLower)) {
        console.error("[Backend] [CONFIRM] Địa chỉ ví không hợp lệ:", userWalletLower);
        return res.status(400).json({ success: false, error: "Địa chỉ ví không hợp lệ." });
    }

    if (typeof txHash !== 'string' || !txHash.startsWith('0x') || txHash.length !== 66) {
        console.error(`[Backend] [CONFIRM] TxHash không hợp lệ (kiểm tra format): ${txHash}. Phải là chuỗi hex 66 ký tự có 0x đầu.`);
        return res.status(400).json({ success: false, error: "Transaction Hash không hợp lệ. Vui lòng cung cấp một hash hợp lệ." });
    }

    try {
        await db.read();
        console.log("[Backend] [CONFIRM] db.data sau db.read():", JSON.stringify(db.data));

        if (db.data.processedTxs[txHash]) {
            console.warn(`[Backend] [CONFIRM] Giao dịch ${txHash} đã được xử lý trước đó.`);
            return res.status(409).json({ success: false, error: "Giao dịch này đã được xử lý." });
        }

        const txReceipt = await provider.getTransactionReceipt(txHash);

        if (!txReceipt) {
            console.warn(`[Backend] [CONFIRM] Giao dịch ${txHash} chưa được tìm thấy hoặc chưa được xác nhận.`);
            return res.status(404).json({ success: false, error: "Giao dịch chưa được tìm thấy hoặc chưa được xác nhận trên blockchain." });
        }

        if (txReceipt.status === 0) {
            console.error(`[Backend] [CONFIRM] Giao dịch ${txHash} thất bại trên blockchain.`);
            return res.status(400).json({ success: false, error: "Giao dịch đã thất bại trên blockchain." });
        }

        const tx = await provider.getTransaction(txHash);

        if (!tx || !tx.to || tx.to.toLowerCase() !== GAME_WALLET_ADDRESS.toLowerCase()) {
            console.warn(`[Backend] [CONFIRM] Giao dịch ${txHash} không gửi đến ví game. Người nhận: ${tx ? tx.to : 'Không có'}. Ví game: ${GAME_WALLET_ADDRESS}`);
            return res.status(400).json({ success: false, error: "Giao dịch không hợp lệ. Không phải gửi đến ví game." });
        }

        if (tx.from.toLowerCase() !== userWalletLower) {
            console.warn(`[Backend] [CONFIRM] Người gửi giao dịch ${tx.from} không khớp với ví người dùng ${userWalletLower} yêu cầu xác nhận.`);
            return res.status(400).json({ success: false, error: "Người gửi giao dịch không khớp với ví của bạn." });
        }

        const valueInWei = tx.value;
        const valueInMTT = parseFloat(formatUnits(valueInWei, NATIVE_COIN_DECIMALS));

        if (valueInMTT <= 0) {
            console.warn(`[Backend] [CONFIRM] Giá trị giao dịch ${txHash} là 0 hoặc âm.`);
            return res.status(400).json({ success: false, error: "Giá trị nạp không hợp lệ (phải lớn hơn 0)." });
        }

        db.data.users[userWalletLower] = (db.data.users[userWalletLower] || 0) + valueInMTT;
        db.data.processedTxs[txHash] = true;
        console.log("[Backend] [CONFIRM] db.data trước khi ghi:", JSON.stringify(db.data));
        await db.write();
        console.log("[Backend] [CONFIRM] db.data sau khi ghi:", JSON.stringify(db.data));

        console.log(`[Backend] [CONFIRM] Đã thêm ${valueInMTT} xu cho ví ${userWalletLower}. Tổng: ${db.data.users[userWalletLower]}`);
        res.json({ success: true, coinsAdded: valueInMTT, totalCoins: db.data.users[userWalletLower] });

    } catch (err) {
        console.error("[Backend] [CONFIRM] Lỗi trong quá trình xác nhận giao dịch:", err);
        let userFriendlyError = "Đã xảy ra lỗi không xác định khi xử lý yêu cầu xác nhận giao dịch.";
        if (err.message.includes("Cannot read properties of undefined")) {
            userFriendlyError = "Lỗi dữ liệu database, có thể cần xóa file db.json.";
        } else if (err.message.includes("invalid argument 0")) {
             userFriendlyError = "Transaction Hash không hợp lệ khi gửi đến blockchain. Kiểm tra lại định dạng.";
        }
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ khi xác nhận giao dịch.", details: err.message || userFriendlyError });
    }
});

// Rút tiền về ví người dùng
app.post("/withdraw", async (req, res) => {
    const { wallet, amount } = req.body;
    const userWalletLower = wallet?.toLowerCase();
    const amountToWithdraw = parseFloat(amount);

    console.log(`[Backend] [WITHDRAW] Yêu cầu rút ${amountToWithdraw} xu từ ví ${userWalletLower}`);

    if (!userWalletLower || !amountToWithdraw || amountToWithdraw <= 0 || isNaN(amountToWithdraw)) {
        console.error("[Backend] [WITHDRAW] Số lượng hoặc địa chỉ ví rút tiền không hợp lệ.");
        return res.status(400).json({ success: false, error: "Số lượng hoặc địa chỉ ví rút tiền không hợp lệ." });
    }

    if (!isAddress(userWalletLower)) {
        console.error("[Backend] [WITHDRAW] Địa chỉ ví nhận không hợp lệ:", userWalletLower);
        return res.status(400).json({ success: false, error: "Địa chỉ ví nhận không hợp lệ." });
    }

    await db.read();
    console.log("[Backend] [WITHDRAW] db.data trước khi xử lý:", JSON.stringify(db.data));
    if (!db.data.users[userWalletLower] || db.data.users[userWalletLower] < amountToWithdraw) {
        console.warn(`[Backend] [WITHDRAW] Ví ${userWalletLower} không đủ xu để rút. Có: ${db.data.users[userWalletLower] || 0}, Cần: ${amountToWithdraw}`);
        return res.status(400).json({ success: false, error: "Không đủ xu trong game để rút." });
    }

    try {
        const amountInWei = parseUnits(amountToWithdraw.toString(), NATIVE_COIN_DECIMALS);

        console.log(`[Backend] [WITHDRAW] Đang gửi ${amountToWithdraw} MTT từ ví game (${gameWallet.address}) đến ${userWalletLower}...`);
        const txResponse = await gameWallet.sendTransaction({
            to: userWalletLower,
            value: amountInWei,
        });

        console.log(`[Backend] [WITHDRAW] Giao dịch rút tiền đã được gửi. Tx Hash: ${txResponse.hash}`);

        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
            db.data.users[userWalletLower] -= amountToWithdraw;
            console.log("[Backend] [WITHDRAW] db.data trước khi ghi:", JSON.stringify(db.data));
            await db.write();
            console.log("[Backend] [WITHDRAW] db.data sau khi ghi:", JSON.stringify(db.data));

            console.log(`[Backend] [WITHDRAW] Đã rút ${amountToWithdraw} xu từ ví ${userWalletLower}. Tổng còn: ${db.data.users[userWalletLower]} xu. TxHash: ${txResponse.hash}`);
            res.json({ success: true, coinsWithdrawn: amountToWithdraw, totalCoins: db.data.users[userWalletLower], txHash: txResponse.hash });
        } else {
            console.error(`[Backend] [WITHDRAW] Giao dịch rút tiền ${txResponse.hash} thất bại trên blockchain.`);
            return res.status(500).json({ success: false, error: "Giao dịch rút tiền thất bại trên blockchain.", details: `Tx Hash: ${txResponse.hash}` });
        }

    } catch (err) {
        console.error("[Backend] [WITHDRAW] Lỗi trong quá trình xử lý rút tiền:", err);
        let userFriendlyError = "Đã xảy ra lỗi không xác định khi xử lý yêu cầu rút tiền.";
        if (err.code === "INSUFFICIENT_FUNDS") {
            userFriendlyError = "Ví game không đủ Native Coin để thực hiện giao dịch hoặc trả phí gas.";
        } else if (err.code === "UNPREDICTABLE_GAS_LIMIT") {
             userFriendlyError = "Không thể ước tính gas cho giao dịch. Có thể có vấn đề với địa chỉ nhận hoặc số lượng.";
        } else if (err.code === "NETWORK_ERROR") {
            userFriendlyError = "Lỗi mạng khi giao tiếp với blockchain.";
        } else if (err.message.includes("invalid address")) {
            userFriendlyError = "Địa chỉ ví nhận không hợp lệ.";
        }
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ.", details: userFriendlyError });
    }
});

// --- ROUTES GAME ---

// Đặt cược
app.post("/play/bet", async (req, res) => {
    const { wallet, betAmount } = req.body;
    const userWalletLower = wallet && wallet.toLowerCase();
    const amount = parseFloat(betAmount);

    console.log(`[Backend] [BET] Nhận request: wallet=${wallet}, betAmount=${betAmount}`);
    await db.read();
    console.log("[Backend] [BET] db.data trước khi xử lý:", JSON.stringify(db.data));

    if (!userWalletLower || !isAddress(userWalletLower) || isNaN(amount) || amount <= 0) {
        console.error("[Backend] [BET] Thiếu thông tin hoặc số tiền cược không hợp lệ!");
        return res.status(400).json({ success: false, error: "Thiếu thông tin hoặc số tiền cược không hợp lệ!" });
    }

    if (!db.data.users[userWalletLower]) db.data.users[userWalletLower] = 0;
    if (db.data.users[userWalletLower] < amount) {
        console.warn(`[Backend] [BET] Không đủ xu để cược: Hiện có ${db.data.users[userWalletLower]}, muốn cược ${amount}`);
        return res.status(400).json({ success: false, error: "Không đủ xu để đặt cược!" });
    }

    db.data.users[userWalletLower] -= amount;
    console.log(`[Backend] [BET] Đã trừ xu, còn lại: ${db.data.users[userWalletLower]}`);
    console.log("[Backend] [BET] db.data trước khi ghi:", JSON.stringify(db.data));
    await db.write();
    console.log("[Backend] [BET] db.data sau khi ghi:", JSON.stringify(db.data));

    return res.json({ success: true, coins: db.data.users[userWalletLower] });
});

// Thắng cược
app.post("/play/win", async (req, res) => {
    const { wallet, winAmount } = req.body;
    const userWalletLower = wallet && wallet.toLowerCase();
    const amount = parseFloat(winAmount);

    console.log(`[Backend] [WIN] Nhận request: wallet=${wallet}, winAmount=${winAmount}`);
    await db.read();
    console.log("[Backend] [WIN] db.data trước khi xử lý:", JSON.stringify(db.data));

    if (!userWalletLower || !isAddress(userWalletLower) || isNaN(amount) || amount <= 0) {
        console.error("[Backend] [WIN] Thiếu thông tin hoặc số tiền thưởng không hợp lệ!");
        return res.status(400).json({ success: false, error: "Thiếu thông tin hoặc số tiền thưởng không hợp lệ!" });
    }

    if (!db.data.users[userWalletLower]) db.data.users[userWalletLower] = 0;
    db.data.users[userWalletLower] += amount;
    console.log(`[Backend] [WIN] Đã cộng xu, tổng mới: ${db.data.users[userWalletLower]}`);
    console.log("[Backend] [WIN] db.data trước khi ghi:", JSON.stringify(db.data));
    await db.write();
    console.log("[Backend] [WIN] db.data sau khi ghi:", JSON.stringify(db.data));

    return res.json({ success: true, coins: db.data.users[userWalletLower] });
});

// ============= ĐẾM LƯỢT CLICK PHÒNG =============

const CLICKS_FILE = './clicks.json';

// Đọc số click từ file
function getClicks() {
    try {
        return JSON.parse(fs.readFileSync(CLICKS_FILE, 'utf8'));
    } catch {
        // Nếu chưa có file, trả về giá trị mặc định cho 3 phòng
        return { room1: 0, room2: 0, room3: 0 };
    }
}

// Ghi số click vào file
function saveClicks(data) {
    fs.writeFileSync(CLICKS_FILE, JSON.stringify(data));
}

// API: Lấy số click hiện tại của các phòng
app.get('/api/clicks', (req, res) => {
    res.json(getClicks());
});

// API: Tăng số click của 1 phòng
app.post('/api/clicks/:room', (req, res) => {
    let clicks = getClicks();
    const room = req.params.room;
    if (!clicks[room]) clicks[room] = 0;
    clicks[room]++;
    saveClicks(clicks);
    res.json({ count: clicks[room] });
});
