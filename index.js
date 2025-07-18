const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const path = require('path');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();
const responseFormatter = require('./middlewares/responseFormatter');
const Transaction = require('./modules/Transactions');
const Chatroom = require('./modules/Chatroom');

const PAYSTACK_SECRET_KEY = process.env.NODE_ENV === 'production' ? process.env.PAYSTACK_LIVE_SECRET_KEY : process.env.PAYSTACK_SECRET_KEY;
console.log('Paystack Secret Key:', PAYSTACK_SECRET_KEY ? '[REDACTED]' : 'NOT_SET');

const requiredEnvVars = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  process.env.NODE_ENV === 'production' ? 'PAYSTACK_LIVE_SECRET_KEY' : 'PAYSTACK_SECRET_KEY',
  'PAYSTACK_API_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

console.log('Environment variables loaded successfully.');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Paystack Secret Key:', process.env.NODE_ENV === 'production' ? 'PAYSTACK_LIVE_SECRET_KEY set' : 'PAYSTACK_SECRET_KEY set');
console.log('Loaded PAYMENT_POINT_SECRET_KEY:', process.env.PAYMENT_POINT_SECRET_KEY ? '[REDACTED]' : 'NOT_SET');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/\/\/(.+?)@/, '//[REDACTED]@') : 'NOT_SET');

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

async function manageIndexes() {
  try {
    const db = mongoose.connection.db;
    try {
      await db.collection('wallets').dropIndex('transactions.reference_1');
      console.log('Dropped transactions.reference_1 index');
    } catch (error) {
      if (error.codeName === 'IndexNotFound') {
        console.log('transactions.reference_1 index not found, no need to drop');
      } else {
        throw error;
      }
    }
    const walletIndexes = await db.collection('wallets').indexes();
    console.log('Current wallet indexes:', JSON.stringify(walletIndexes, null, 2));
  } catch (error) {
    console.error('Index management error:', error.message);
    throw error;
  }
}

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://escrow-app.onrender.com',
      'https://escrow-app-delta.vercel.app',
      'https://escrowserver.onrender.com',
      'https://api.multiavatar.com',
      'https://mymiddleman.ng',
      'https://paywithsylo.com',
      'https://1ea518b60f04.ngrok-free.app',
      'http://localhost:3001',
      undefined,
    ];
    console.log('Checking origin:', origin);
    if (allowedOrigins.includes(origin) || !origin) {
      console.log('Origin allowed:', origin || 'No origin (e.g., webhook)');
      callback(null, true);
    } else {
      console.log('Origin denied:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'access-token', 'x-access-token', 'x-paystack-signature'],
  optionsSuccessStatus: 204,
  preflightContinue: false,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`Response for ${req.method} ${req.url}:`, res.getHeaders());
  });
  next();
});

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  const origin = socket.handshake.headers.origin;
  console.log('Socket.IO auth attempt:', {
    token: token ? '[REDACTED]' : 'No token',
    origin,
    query: socket.handshake.query,
    clientIp: socket.handshake.address,
    time: new Date().toISOString(),
  });

  if (!token) {
    console.error('Socket.IO authentication failed: No token provided', {
      origin,
      clientIp: socket.handshake.address,
      headers: socket.handshake.headers,
    });
    return next(new Error('Authentication error: No token provided'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Socket.IO authentication success:', {
      userId: decoded.id,
      email: decoded.email,
      origin,
      time: new Date().toISOString(),
    });
    socket.user = decoded;
    next();
  } catch (error) {
    console.error('Socket.IO authentication error:', {
      message: error.message,
      token: token ? '[REDACTED]' : 'No token',
      origin,
      clientIp: socket.handshake.address,
      stack: error.stack,
    });
    return next(new Error(`Authentication error: ${error.message}`));
  }
});

const setupSocket = (io) => {
  io.on('connection', (socket) => {
    console.log('User connected:', {
      userId: socket.user.id,
      socketId: socket.id,
      clientIp: socket.handshake.address,
      time: new Date().toISOString(),
    });

    socket.on('join-room', async (room, userId) => {
      if (room.startsWith('transaction_')) {
        const chatroomId = room.replace('transaction_', '');
        try {
          const chatroom = await Chatroom.findById(chatroomId);
          if (!chatroom) {
            console.error(`Chatroom ${chatroomId} not found`);
            socket.emit('error', { message: 'Chatroom not found' });
            return;
          }

          const transaction = await Transaction.findById(chatroom.transactionId);
          if (!transaction) {
            console.error(`Transaction ${chatroom.transactionId} not found`);
            socket.emit('error', { message: 'Transaction not found' });
            return;
          }

          const isCreator = transaction.userId.toString() === userId;
          const isParticipant = transaction.participants.some(
            (p) => p.toString() === userId
          );

          if (!isCreator && !isParticipant) {
            console.error(`User ${userId} attempted to join unauthorized room ${room}`);
            socket.emit('error', { message: 'Unauthorized to join this chatroom' });
            return;
          }

          socket.join(room);
          console.log(`User ${userId} joined room ${room}`);
        } catch (error) {
          console.error(`Error joining room ${room}:`, error);
          socket.emit('error', { message: 'Failed to join chatroom' });
        }
      } else {
        socket.join(room);
        console.log(`User ${userId} joined room ${room}`);
      }
    });

    socket.on('message', (message) => {
      console.log('Message received:', { message, userId: socket.user.id });
      io.to(`transaction_${message.chatroomId}`).emit('message', message);
    });

    socket.on('disconnect', (reason) => {
      console.log('User disconnected:', {
        userId: socket.user.id,
        socketId: socket.id,
        reason,
        time: new Date().toISOString(),
      });
    });
  });
};

setupSocket(io);

app.set('io', io);

app.set('timeout', 60000);

app.use(express.urlencoded({ extended: false }));
app.use('/uploads/images', express.static(path.join(__dirname, 'Uploads/images')));
app.use('/api/wallet/verify-funding', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(express.json());
app.use(responseFormatter);

const initializeRoutes = () => {
  const authRoutes = require('./routes/authRoutes');
  const userRoutes = require('./routes/userRoutes');
  const transactionRoutes = require('./routes/transactionRoutes');
  const notificationRoutes = require('./routes/notificationRoutes');
  const kycRoutes = require('./routes/kycRoutes');
  const walletRoutes = require('./routes/walletRoutes');
  const messageRoutes = require('./routes/messages');

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/transactions', transactionRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/kyc', kycRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/wallet', walletRoutes);
};

app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

app.get('/api/avatar/:seed', async (req, res) => {
  try {
    const seed = req.params.seed;
    const multiavatarUrl = `https://api.multiavatar.com/${encodeURIComponent(seed)}.svg`;

    const response = await axios.get(multiavatarUrl, {
      responseType: 'stream',
      timeout: 10000,
    });

    res.set('Content-Type', 'image/svg+xml');
    response.data.pipe(res);
  } catch (error) {
    console.error('Avatar proxy error:', {
      seed: req.params.seed,
      message: error.message,
      status: error.response?.status,
      code: error.code,
      stack: error.stack,
    });

    if (error.response?.status === 429) {
      res.status(429).send('Multiavatar rate limit exceeded. Please try again later.');
    } else if (error.code === 'ECONNABORTED' || error.response?.status === 408) {
      res.status(504).send('Avatar request timed out. Using fallback.');
    } else {
      const fallbackSvg = `
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="15" fill="#B38939" />
          <text x="50%" y="50%" font-size="12" fill="white" text-anchor="middle" dominant-baseline="middle">${req.params.seed.slice(0, 2)}</text>
        </svg>
      `;
      res.set('Content-Type', 'image/svg+xml');
      res.status(200).send(fallbackSvg);
    }
  }
});

const cronJobs = require('./jobs/cronJobs');
cronJobs();

async function startServer() {
  try {
    await connectDB();
    await manageIndexes();
    console.log('Index management completed');
    initializeRoutes();
    server.setTimeout(120000);
    console.log('Server timeout set to:', server.timeout / 1000, 'seconds');
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
      console.log('Paystack Secret Key Mode:', process.env.NODE_ENV === 'production' ? 'Live' : 'Test');
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();