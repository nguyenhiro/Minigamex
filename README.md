# Web Token Game

## Cách chạy local

### 1. Chạy backend
```bash
cd backend
npm install
node server.js
```

### 2. Mở frontend
Mở file `frontend/index.html` trong trình duyệt để chạy game.

---

## API

- `POST /confirm` – xác nhận giao dịch token
- `GET /balance/:wallet` – lấy số xu theo ví
