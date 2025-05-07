const express = require("express");
const app = express();
const cors = require("cors");
const http = require("http");
const connectDB = require('./config/db');
const path = require('path');
const socket = require("socket.io");
const bodyParser = require('body-parser');
require("dotenv").config();

// Debug log to confirm loading
console.log('Loaded PAYMENT_POINT_SECRET_KEY:', process.env.PAYMENT_POINT_SECRET_KEY);

const corsOptions = {
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  credentials: false,
  allowedHeaders: "Content-Type, Authorization, auth-token, x-auth-token, Paymentpoint-Signature",
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

app.use(function (request, response, next) {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, auth-token, x-auth-token, Paymentpoint-Signature");
  next();
});

const io = socket({
  cors: {
    origin: [
      "http://localhost:5173",
      "https://escrow-app.onrender.com",
      "https://escrow-app-delta.vercel.app",
      "https://escrowserver.onrender.com",
      "https://api.multiavatar.com",
      "https://mymiddleman.ng",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.urlencoded({ extended: false }));
app.use('/uploads/images', express.static(path.join(__dirname, 'uploads/images')));

// Use express.raw() for the webhook endpoint to get the raw body
app.use('/api/wallet/verify-funding', express.raw({ type: 'application/json' }));
// Use body-parser.json() for all other routes
app.use(bodyParser.json());

io.on("connection", (socket) => {
  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    socket.on("message", (message) => {
      io.to(roomId).emit("message", message);
    });
    socket.on("disconnect", () => {
      io.to(roomId).emit("user-disconnected", userId);
    });
  });
});

// Connect to the database
connectDB();

// Middleware
app.use(express.json());

// Function to initialize routes after dotenv is loaded
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

// Call the function to initialize routes
initializeRoutes();

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Load cron jobs
require('./cronJobs');

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});

io.attach(server);