const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const path = require('path');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const fs = require('fs'); // Add this
require('dotenv').config();
const requiredEnvVars = [
  'JWT_SECRET',
  'MONGODB_URI',
  process.env.NODE_ENV === 'production' ? 'PAYSTACK_LIVE_SECRET_KEY' : 'PAYSTACK_TEST_SECRET_KEY',
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
console.log('Paystack Secret Key:', process.env.NODE_ENV === 'production' ? 'PAYSTACK_LIVE_SECRET_KEY set' : 'PAYSTACK_TEST_SECRET_KEY set');

const mongoose = require('mongoose');
const responseFormatter = require('./middlewares/responseFormatter');

async function manageIndexes() {
  try {
    const db = mongoose.connection.db;
    // Drop problematic index
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
    // Ensure new compound index (already defined in wallet.js)
    const walletIndexes = await db.collection('wallets').indexes();
    console.log('Current wallet indexes:', JSON.stringify(walletIndexes, null, 2));
  } catch (error) {
    console.error('Index management error:', error.message);
    throw error;
  }
}
console.log('Loaded PAYMENT_POINT_SECRET_KEY:', process.env.PAYMENT_POINT_SECRET_KEY ? '[REDACTED]' : 'NOT_SET');
console.log('MONGODB_URI:', process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/\/\/(.+?)@/, '//[REDACTED]@') : 'NOT_SET');

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
    ];
    console.log('Checking origin:', origin); // Debug log
    if (!origin || allowedOrigins.includes(origin)) {
      console.log('Origin allowed:', origin); // Debug log
      callback(null, true);
    } else {
      console.log('Origin denied:', origin); // Debug log
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'auth-token', 'x-auth-token', 'Paymentpoint-Signature'],
  optionsSuccessStatus: 204,
  preflightContinue: false,
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

// Proxy endpoint for MultiAvatar
app.get('/api/avatar/:seed', async (req, res) => {
  try {
    const seed = req.params.seed;
    const multiavatarUrl = `https://api.multiavatar.com/${encodeURIComponent(seed)}.svg`;

    const response = await axios.get(multiavatarUrl, {
      responseType: 'stream',
      timeout: 10000, // 10-second timeout
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
      // Fallback: Generate a simple SVG circle as a placeholder
      const fallbackSvg = `
        <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="15" fill="#B38939" />
          <text x="50%" y="50%" font-size="12" fill="white" text-anchor="middle" dominant-baseline="middle">${seed.slice(0, 2)}</text>
        </svg>
      `;
      res.set('Content-Type', 'image/svg+xml');
      res.status(200).send(fallbackSvg);
    }
  }
});

require('./cronJobs');

async function startServer() {
  try {
    await connectDB();
    await manageIndexes();
    console.log('Index management completed');
    initializeRoutes();
    server.setTimeout(600000);
    console.log('Server timeout set to:', server.timeout / 1000, 'seconds');
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