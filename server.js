// server.js - Backend Node.js hoàn chỉnh (tích hợp quản lý user, nạp/rút xu, đặt cược, thắng cược, & thống kê click phòng). 
// Lưu dữ liệu vào db.json & clicks.json. Hỗ trợ socket.io realtime cho lượt click phòng.

const express = require("express");
const fs = require("fs");
const { JsonRpcProvider, isAddress, formatUnits, Wallet, parseUnits } = require("ethers");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors({
  origin: [
    'https://nguyenhiro.github.io', // Cho phép GitHub Pages
    'http://127.0.0.1:5500'         // Nếu muốn vẫn cho phép local
  ]
}));
app.use(express.json());
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

// ========== DB USERS & TX =============
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const file = './db.json';
const adapter = new JSONFile(file);
const db = new Low(adapter, { users: {}, processedTxs: {} });

// ========== SOCKET.IO SETUP ===========
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http, {
    cors: { origin: "http://127.0.0.1:5500" }
});
app.set('io', io);

// ========== INIT APP ==================
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

        http.listen(PORT, () => {
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

// ========== SOCKET.IO EVENTS ==========
io.on('connection', (socket) => {
    console.log('A client connected');
    // Gửi số click lần đầu cho client luôn
    socket.emit('updateClicks', getClicks());
});

// ========== ROUTES GAME ===============

// Lấy số xu cho ví người dùng
app.get("/balance/:wallet", async (req, res) => {
    const userWallet = req.params.wallet.toLowerCase();
    await db.read();
    try {
        if (!db.data || !db.data.users || !(userWallet in db.data.users)) {
            return res.json({ coins: 0 });
        }
        res.json({ coins: db.data.users[userWallet] });
    } catch (error) {
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ khi lấy số dư.", details: error.message });
    }
});

// Xác nhận nạp xu bằng giao dịch blockchain
app.post("/confirm", async (req, res) => {
    const { wallet, txHash } = req.body;
    const userWalletLower = wallet?.toLowerCase();

    if (!userWalletLower || !txHash) {
        return res.status(400).json({ success: false, error: "Thiếu thông tin ví hoặc Transaction Hash." });
    }

    if (!isAddress(userWalletLower)) {
        return res.status(400).json({ success: false, error: "Địa chỉ ví không hợp lệ." });
    }

    if (typeof txHash !== 'string' || !txHash.startsWith('0x') || txHash.length !== 66) {
        return res.status(400).json({ success: false, error: "Transaction Hash không hợp lệ. Vui lòng cung cấp một hash hợp lệ." });
    }

    try {
        await db.read();

        if (db.data.processedTxs[txHash]) {
            return res.status(409).json({ success: false, error: "Giao dịch này đã được xử lý." });
        }

        const txReceipt = await provider.getTransactionReceipt(txHash);

        if (!txReceipt) {
            return res.status(404).json({ success: false, error: "Giao dịch chưa được tìm thấy hoặc chưa được xác nhận trên blockchain." });
        }

        if (txReceipt.status === 0) {
            return res.status(400).json({ success: false, error: "Giao dịch đã thất bại trên blockchain." });
        }

        const tx = await provider.getTransaction(txHash);

        if (!tx || !tx.to || tx.to.toLowerCase() !== GAME_WALLET_ADDRESS.toLowerCase()) {
            return res.status(400).json({ success: false, error: "Giao dịch không hợp lệ. Không phải gửi đến ví game." });
        }

        if (tx.from.toLowerCase() !== userWalletLower) {
            return res.status(400).json({ success: false, error: "Người gửi giao dịch không khớp với ví của bạn." });
        }

        const valueInWei = tx.value;
        const valueInMTT = parseFloat(formatUnits(valueInWei, NATIVE_COIN_DECIMALS));

        if (valueInMTT <= 0) {
            return res.status(400).json({ success: false, error: "Giá trị nạp không hợp lệ (phải lớn hơn 0)." });
        }

        db.data.users[userWalletLower] = (db.data.users[userWalletLower] || 0) + valueInMTT;
        db.data.processedTxs[txHash] = true;
        await db.write();

        res.json({ success: true, coinsAdded: valueInMTT, totalCoins: db.data.users[userWalletLower] });

    } catch (err) {
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ khi xác nhận giao dịch.", details: err.message });
    }
});

// Rút tiền về ví người dùng
app.post("/withdraw", async (req, res) => {
    const { wallet, amount } = req.body;
    const userWalletLower = wallet?.toLowerCase();
    const amountToWithdraw = parseFloat(amount);

    if (!userWalletLower || !amountToWithdraw || amountToWithdraw <= 0 || isNaN(amountToWithdraw)) {
        return res.status(400).json({ success: false, error: "Số lượng hoặc địa chỉ ví rút tiền không hợp lệ." });
    }

    if (!isAddress(userWalletLower)) {
        return res.status(400).json({ success: false, error: "Địa chỉ ví nhận không hợp lệ." });
    }

    await db.read();
    if (!db.data.users[userWalletLower] || db.data.users[userWalletLower] < amountToWithdraw) {
        return res.status(400).json({ success: false, error: "Không đủ xu trong game để rút." });
    }

    try {
        const amountInWei = parseUnits(amountToWithdraw.toString(), NATIVE_COIN_DECIMALS);
        const txResponse = await gameWallet.sendTransaction({
            to: userWalletLower,
            value: amountInWei,
        });

        const receipt = await txResponse.wait();

        if (receipt.status === 1) {
            db.data.users[userWalletLower] -= amountToWithdraw;
            await db.write();
            res.json({ success: true, coinsWithdrawn: amountToWithdraw, totalCoins: db.data.users[userWalletLower], txHash: txResponse.hash });
        } else {
            return res.status(500).json({ success: false, error: "Giao dịch rút tiền thất bại trên blockchain.", details: `Tx Hash: ${txResponse.hash}` });
        }

    } catch (err) {
        res.status(500).json({ success: false, error: "Lỗi nội bộ máy chủ.", details: err.message });
    }
});

// Đặt cược
app.post("/play/bet", async (req, res) => {
    const { wallet, betAmount } = req.body;
    const userWalletLower = wallet && wallet.toLowerCase();
    const amount = parseFloat(betAmount);

    await db.read();

    if (!userWalletLower || !isAddress(userWalletLower) || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: "Thiếu thông tin hoặc số tiền cược không hợp lệ!" });
    }

    if (!db.data.users[userWalletLower]) db.data.users[userWalletLower] = 0;
    if (db.data.users[userWalletLower] < amount) {
        return res.status(400).json({ success: false, error: "Không đủ xu để đặt cược!" });
    }

    db.data.users[userWalletLower] -= amount;
    await db.write();

    return res.json({ success: true, coins: db.data.users[userWalletLower] });
});

// Thắng cược
app.post("/play/win", async (req, res) => {
    const { wallet, winAmount } = req.body;
    const userWalletLower = wallet && wallet.toLowerCase();
    const amount = parseFloat(winAmount);

    await db.read();

    if (!userWalletLower || !isAddress(userWalletLower) || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: "Thiếu thông tin hoặc số tiền thưởng không hợp lệ!" });
    }

    if (!db.data.users[userWalletLower]) db.data.users[userWalletLower] = 0;
    db.data.users[userWalletLower] += amount;
    await db.write();

    return res.json({ success: true, coins: db.data.users[userWalletLower] });
});

// ============= ĐẾM LƯỢT CLICK PHÒNG =============

const CLICKS_FILE = './clicks.json';

// Đọc số click từ file
function getClicks() {
    try {
        return JSON.parse(fs.readFileSync(CLICKS_FILE, 'utf8'));
    } catch {
        // Nếu chưa có file, trả về giá trị mặc định cho 10 phòng
        return { 
            room1: 0, room2: 0, room3: 0, room4: 0, room5: 0,
            room6: 0, room7: 0, room8: 0, room9: 0, room10: 0 
        };
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

// API: Tăng số click của 1 phòng (Realtime cập nhật cho tất cả client)
app.post('/api/clicks/:room', (req, res) => {
    let clicks = getClicks();
    const room = req.params.room;
    if (!clicks[room]) clicks[room] = 0;
    clicks[room]++;
    saveClicks(clicks);
    res.json({ count: clicks[room] });
    // Gửi realtime tới tất cả client
    io.emit('updateClicks', clicks);
});
