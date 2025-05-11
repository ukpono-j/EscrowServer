const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const path = require('path');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const mongoose = require('mongoose');

async function manageIndexes() {
  try {
    const db = mongoose.connection.db;
    await db.collection('wallets').createIndex({ userId: 1 }, { unique: true, name: 'userId_1' });
    console.log('Ensured userId_1 index on wallets collection');
    const walletIndexes = await db.collection('wallets').indexes();
    console.log('Current wallet indexes:', JSON.stringify(walletIndexes, null, 2));
  } catch (error) {
    console.error('Index management error:', error.message);
    if (process.env.NODE_ENV === 'production') {
      console.warn('Continuing server startup despite index management error');
      return;
    }
    throw error;
  }
}

console.log('Loaded PAYMENT_POINT_SECRET_KEY:', process.env.PAYMENT_POINT_SECRET_KEY ? '[REDACTED]' : 'NOT_SET');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/\/\/(.+?)@/, '//[REDACTED]@') : 'NOT_SET');

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'https://escrow-app.onrender.com',
      'https://escrow-app-delta.vercel.app',
      'https://escrowserver.onrender.com',
      'https://api.multiavatar.com',
      'https://mymiddleman.ng',
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'auth-token', 'x-auth-token', 'Paymentpoint-Signature'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight requests for all routes

// Log response headers for debugging
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
});

// Socket.IO Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch (error) {
    console.error('Socket.IO authentication error:', error.message);
    next(new Error('Authentication error: Invalid token'));
  }
});

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.userId);

  socket.on('join-room', (userId) => {
    if (userId === socket.userId) {
      socket.join(userId);
      console.log(`User ${userId} joined room ${userId}`);
    } else {
      console.warn(`User ${socket.userId} attempted to join unauthorized room ${userId}`);
    }
  });

  socket.on('join-room', (roomId, userId) => {
    if (userId === socket.userId) {
      socket.join(roomId);
      console.log(`User ${userId} joined chat room ${roomId}`);
      socket.on('message', (message) => {
        io.to(roomId).emit('message', message);
      });
      socket.on('disconnect', () => {
        io.to(roomId).emit('user-disconnected', userId);
        console.log(`User ${userId} disconnected from chat room ${roomId}`);
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.userId);
  });
});

app.set('io', io);

app.use(express.urlencoded({ extended: false }));
app.use('/uploads/images', express.static(path.join(__dirname, 'Uploads/images')));
app.use('/api/wallet/verify-funding', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(express.json());

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

require('./cronJobs');

async function startServer() {
  try {
    await connectDB();
    await manageIndexes();
    console.log('Index management completed');
    initializeRoutes();
    server.setTimeout(600000); // Increase to 10 minutes
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();