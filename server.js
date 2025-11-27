// 必要なライブラリ
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const path = require('path');
const webpush = require('web-push'); 

// Socket.IO CORS設定
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let orders = [];
let orderCounter = 1; 
let subscriptions = {};
let customerSockets = {};

// VAPIDキー
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("Web Push設定完了。");
} else {
  console.warn("VAPIDキー未設定。");
}

app.use(express.json());
app.use(express.static(path.join(__dirname))); 

// --- ルーティング ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'order.html')); });
app.get('/cashier', (req, res) => { res.sendFile(path.join(__dirname, 'cashier.html')); });
app.get('/kitchen', (req, res) => { res.sendFile(path.join(__dirname, 'kitchen.html')); });

// --- API ---
// [POST] /api/order
app.post('/api/order', (req, res) => {
  const items = req.body.items;
  if (!items || items.length === 0) { return res.status(400).json({ message: '注文内容が空です。' }); }
  const newOrder = { id: orderCounter++, items: items, status: '支払い待ち', createdAt: new Date() };
  orders.push(newOrder);
  io.emit('new_pending_order', newOrder); 
  res.status(201).json({ message: '注文を受け付けました。レジでお支払いください。', orderId: newOrder.id });
});

// ★★★ [NEW] 注文状態確認API (レシート再表示用) ★★★
app.get('/api/order/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = orders.find(o => o.id === id);
  if (order) {
    res.json(order);
  } else {
    res.status(404).json({ message: '注文が見つかりません' });
  }
});

// [GET] /api/sales/today
app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0, totalItems = 0;
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    orders.forEach(order => {
        if (order.status !== '支払い待ち' && order.createdAt.toISOString().split('T')[0] === todayString) {
            order.items.forEach(item => {
                totalRevenue += item.price * item.quantity;
                totalItems += item.quantity;
            });
        }
    });
    res.json({ totalRevenue, totalItems, date: todayString });
});

// [POST] /api/subscribe
app.post('/api/subscribe', (req, res) => {
  const { subscription, orderId } = req.body;
  if (!subscription || !orderId) { return res.status(400).json({ error: '購読情報または注文IDがありません。' }); }
  subscriptions[orderId] = subscription;
  res.status(201).json({ message: '購読成功' });
});

// --- リアルタイム通信 (Socket.IO) ---
io.on('connection', (socket) => {
  console.log('クライアント接続:', socket.id);
  socket.emit('initial_orders', orders);

  // レジからの「支払い完了」
  socket.on('confirm_payment', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '支払い待ち') {
      order.status = '受付済';
      io.emit('new_kitchen_order', order); 
      
      // ★ 特定のお客様に「支払い完了」通知
      const targetSocketId = customerSockets[id];
      if (targetSocketId) {
        io.to(targetSocketId).emit('payment_confirmed', order);
      }
    }
  });
  
  // 厨房からの「ステータス更新」
  socket.on('update_status', ({ id, status }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status !== '提供可能') { 
      order.status = status;
      console.log(`ステータス更新: ${id} -> ${status}`);
      io.emit('status_updated', order);
    }
  });

  // 厨房からの「調理完了」
  socket.on('cooking_complete', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '調理中') {
      order.status = '提供可能';
      console.log(`調理完了: ${id}`);
      io.emit('order_is_ready', order);
    }
  });

  // お客様画面からの「注文番号登録」
  socket.on('register_customer', ({ orderId }) => {
    if (orderId) customerSockets[orderId] = socket.id;
  });

  // レジ画面からの「呼び出し」
  socket.on('call_customer', ({ id }) => {
    console.log(`レジから呼び出し: 注文番号 ${id}`);
    const order = orders.find(o => o.id === id);
    
    if (order && order.status === '提供可能') {
        order.status = '提供済み';
        console.log(`ステータス更新: ${id} -> 提供済み`);
        io.emit('status_updated', order); 
    }

    const targetSocketId = customerSockets[id];
    if (targetSocketId) io.to(targetSocketId).emit('order_ready');

    const subscription = subscriptions[id];
    if (subscription) {
      const payload = JSON.stringify({ title: 'ご注文の準備ができました！', body: `注文番号: ${id} 番のお客様、カウンターまでお越しください。` });
      webpush.sendNotification(subscription, payload)
        .then(() => { delete subscriptions[id]; delete customerSockets[id]; })
        .catch(err => { if (err.statusCode === 410 || err.
