const express = require("express");
const cors = require("cors");
const http = require("http");
const connectDB = require("./config/db");
const path = require("path");
const webpush = require('web-push');
const socketIo = require("socket.io");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const axios = require("axios");
const multer = require("multer");
const compression = require("compression");
require("dotenv").config();
const cloudinary = require('cloudinary').v2;
const responseFormatter = require("./middlewares/responseFormatter");
const Transaction = require("./modules/Transactions");
const Chatroom = require("./modules/Chatroom");
const User = require("./modules/Users");
const Message = require("./modules/Message");
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger-output.json');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

webpush.setVapidDetails(
  process.env.VAPID_MAILTO,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Configure multer for file uploads (using memory storage for Cloudinary uploads)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const validTypes = ["image/jpeg", "image/png"];
    if (!validTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPEG or PNG files are allowed"));
    }
    if (file.size > 5 * 1024 * 1024) {
      return cb(new Error("File size must be less than 5MB"));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      process.env.VITE_BASE_URL || "http://localhost:5173",
      "http://localhost:5174",
      "https://res.cloudinary.com",
      "https://api.multiavatar.com",
      "https://escrow-app.onrender.com",
      "https://escrow-app-delta.vercel.app",
      "https://escrowserver.onrender.com",
      "https://sylo-admin.vercel.app",
      "https://paywithsylo.com",
      "https://1ea518b60f04.ngrok-free.app",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
});

app.set("io", io);
app.set("upload", upload);

// Apply compression middleware
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/Uploads/images')) {
      return true;
    }
    return compression.filter(req, res);
  },
  level: 6,
}));

const PAYSTACK_SECRET_KEY = process.env.NODE_ENV === "production"
  ? process.env.PAYSTACK_LIVE_SECRET_KEY
  : process.env.PAYSTACK_SECRET_KEY;

const requiredEnvVars = [
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "MONGODB_URI",
  process.env.NODE_ENV === "production" ? "PAYSTACK_LIVE_SECRET_KEY" : "PAYSTACK_SECRET_KEY",
  "PAYSTACK_API_URL",
  "YOUVERIFY_API_KEY",
];

const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error("Missing required environment variables:", missingEnvVars);
  process.exit(1);
}

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

async function manageIndexes() {
  try {
    const db = mongoose.connection.db;

    // Drop old transactions.reference_1 index
    try {
      await db.collection("wallets").dropIndex("transactions.reference_1");
      console.log("Dropped transactions.reference_1 index");
    } catch (error) {
      if (error.codeName === "IndexNotFound") {
        console.log("transactions.reference_1 index not found, no need to drop");
      } else {
        throw error;
      }
    }

    // Drop avatarSeed_1 index from users collection
    try {
      await db.collection("users").dropIndex("avatarSeed_1");
      console.log("Dropped avatarSeed_1 index from users collection");
    } catch (error) {
      if (error.codeName === "IndexNotFound") {
        console.log("avatarSeed_1 index not found, no need to drop");
      } else {
        throw error;
      }
    }

    // Remove avatarSeed field from all user documents
    try {
      const result = await User.updateMany(
        { avatarSeed: { $exists: true } },
        { $unset: { avatarSeed: "" } }
      );
      console.log(`Removed avatarSeed field from ${result.modifiedCount} user documents`);
    } catch (error) {
      console.error("Error removing avatarSeed field:", error.message);
    }

    const walletIndexes = await db.collection("wallets").indexes();
    console.log("Current wallet indexes:", JSON.stringify(walletIndexes, null, 2));

    const userIndexes = await db.collection("users").indexes();
    console.log("Current user indexes:", JSON.stringify(userIndexes, null, 2));
  } catch (error) {
    console.error("Index management error:", error.message);
    throw error;
  }
}

const corsOptions = {
  origin: [
    process.env.VITE_BASE_URL || "http://localhost:5173",
    "http://localhost:5174",
    "https://res.cloudinary.com",
    "https://api.multiavatar.com",
    "https://escrow-app.onrender.com",
    "https://escrow-app-delta.vercel.app",
    "https://escrowserver.onrender.com",
    "https://mymiddleman.ng",
    "https://sylo-admin.vercel.app",
    "https://paywithsylo.com",
    "https://1ea518b60f04.ngrok-free.app",
    "http://localhost:3001",
  ],
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "access-token", "x-access-token", "x-paystack-signature"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`Response for ${req.method} ${req.url}:`, res.getHeaders());
  });
  next();
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error("Socket authentication failed: No token provided", {
      socketId: socket.id,
      time: new Date().toISOString(),
    });
    return next(new Error("Authentication error: No token provided"));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    socket.join(`user_${decoded.id}`);
    console.log("Socket authenticated successfully:", {
      userId: decoded.id,
      socketId: socket.id,
      time: new Date().toISOString(),
    });
    next();
  } catch (error) {
    console.error("Socket authentication error:", {
      socketId: socket.id,
      message: error.message,
      time: new Date().toISOString(),
    });
    return next(new Error(`Authentication error: ${error.message}`));
  }
});

const setupSocket = (io) => {
  io.on("connection", (socket) => {
    console.log("User connected:", {
      userId: socket.user.id,
      socketId: socket.id,
      clientIp: socket.handshake.address,
      time: new Date().toISOString(),
    });

    socket.on("join-room", async (room, userId) => {
      if (room.startsWith("transaction_")) {
        const chatroomId = room.replace("transaction_", "");
        try {
          const chatroom = await Chatroom.findById(chatroomId);
          if (!chatroom) {
            console.error("Chatroom not found:", {
              chatroomId,
              userId,
              socketId: socket.id,
              time: new Date().toISOString(),
            });
            socket.emit("error", { message: "Chatroom not found" });
            return;
          }
          const transaction = await Transaction.findById(chatroom.transactionId)
            .populate('participants.userId', 'firstName lastName email');
          if (!transaction) {
            console.error("Transaction not found:", {
              chatroomId,
              userId,
              socketId: socket.id,
              time: new Date().toISOString(),
            });
            socket.emit("error", { message: "Transaction not found" });
            return;
          }
          const isCreator = transaction.userId.toString() === userId;
          const isParticipant = transaction.participants.some(p => p.userId && p.userId._id.toString() === userId);
          if (!isCreator && !isParticipant) {
            console.error("Unauthorized room join attempt:", {
              userId,
              room,
              socketId: socket.id,
              time: new Date().toISOString(),
            });
            socket.emit("error", { message: "Unauthorized to join this chatroom" });
            return;
          }
          socket.join(room);
          console.log("User joined room:", {
            userId,
            room,
            socketId: socket.id,
            time: new Date().toISOString(),
          });
        } catch (error) {
          console.error("Error joining chatroom:", {
            userId,
            room,
            socketId: socket.id,
            message: error.message,
            time: new Date().toISOString(),
          });
          socket.emit("error", { message: "Failed to join chatroom" });
        }
      } else {
        socket.join(room);
        console.log("User joined room:", {
          userId,
          room,
          socketId: socket.id,
          time: new Date().toISOString(),
        });
      }
    });

    socket.on("message", async (message) => {
      console.log("Message received:", {
        userId: socket.user.id,
        chatroomId: message.chatroomId,
        socketId: socket.id,
        time: new Date().toISOString(),
      });

      try {
        if (!mongoose.Types.ObjectId.isValid(message.chatroomId) || !mongoose.Types.ObjectId.isValid(message.userId)) {
          console.error("Invalid message data:", { message, userId: socket.user.id });
          socket.emit("error", { message: "Invalid message data" });
          return;
        }

        const chatroom = await Chatroom.findById(message.chatroomId);
        if (!chatroom) {
          console.error("Chatroom not found for message:", { chatroomId: message.chatroomId, userId: socket.user.id });
          socket.emit("error", { message: "Chatroom not found" });
          return;
        }

        const user = await User.findById(message.userId).select('firstName lastName');
        if (!user) {
          console.error("User not found for message:", { userId: message.userId });
          socket.emit("error", { message: "User not found" });
          return;
        }

        io.to(`transaction_${message.chatroomId}`).emit("message", {
          _id: message._id,
          chatroomId: message.chatroomId,
          userId: message.userId,
          userFirstName: message.userFirstName,
          userLastName: message.userLastName,
          message: message.message,
          timestamp: message.timestamp,
          tempId: message.tempId,
        });
        console.log("Message broadcasted to room:", `transaction_${message.chatroomId}`);
      } catch (error) {
        console.error("Error broadcasting socket message:", {
          userId: socket.user.id,
          chatroomId: message.chatroomId,
          message: error.message,
          stack: error.stack,
        });
        socket.emit("error", { message: "Failed to broadcast message" });
      }
    });

    socket.on("balanceUpdate", (data) => {
      console.log("Balance update received:", {
        userId: socket.user.id,
        socketId: socket.id,
        amount: data.amount,
        reference: data.reference,
        time: new Date().toISOString(),
      });
      io.to(`user_${socket.user.id}`).emit("balanceUpdate", data);
    });

    socket.on("typing", (data) => {
      io.to(`transaction_${data.chatroomId}`).emit("typing", data);
    });

    socket.on("stop-typing", (data) => {
      io.to(`transaction_${data.chatroomId}`).emit("stop-typing", data);
    });

    socket.on("ping", (data) => {
      socket.emit("pong", { userId: data.userId });
    });

    socket.on("reconnect", (attempt) => {
      console.log("Socket reconnected:", {
        userId: socket.user.id,
        socketId: socket.id,
        attempt,
        time: new Date().toISOString(),
      });
    });

    socket.on("reconnect_error", (error) => {
      console.error("Socket reconnection error:", {
        userId: socket.user.id,
        socketId: socket.id,
        message: error.message,
        time: new Date().toISOString(),
      });
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", {
        userId: socket.user.id,
        socketId: socket.id,
        message: error.message,
        time: new Date().toISOString(),
      });
    });

    socket.on("disconnect", (reason) => {
      console.log("User disconnected:", {
        userId: socket.user.id,
        socketId: socket.id,
        reason,
        time: new Date().toISOString(),
      });
    });
  });
};

setupSocket(io);

app.set("timeout", 60000);
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.json());
app.use(responseFormatter);

// Serve Swagger UI at /api-docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Initialize routes
const initializeRoutes = () => {
  try {
    const authRoutes = require("./routes/authRoutes");
    const userRoutes = require("./routes/userRoutes");
    const transactionRoutes = require("./routes/transactionRoutes");
    const notificationRoutes = require("./routes/notificationRoutes");
    const kycRoutes = require("./routes/kycRoutes");
    const walletRoutes = require("./routes/walletRoutes");
    const messageRoutes = require("./routes/messages");
    const adminRoutes = require("./routes/adminRoutes");

    app.use("/api/auth", authRoutes);
    app.use("/api/users", userRoutes);
    app.use("/api/transactions", transactionRoutes);
    app.use("/api/notifications", notificationRoutes);
    app.use("/api/kyc", kycRoutes);
    app.use("/api/wallet", walletRoutes);
    app.use("/api/messages", messageRoutes);
    app.use("/api/admin", adminRoutes);

    // Add this to log all registered routes
    console.log("Registered routes:", app._router.stack
      .filter(r => r.route)
      .map(r => `${r.route.path} (${Object.keys(r.route.methods).join(", ")})`));


    console.log("Routes initialized successfully");
  } catch (error) {
    console.error("Error initializing routes:", {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

app.use((err, req, res, next) => {
  console.error("Server Error:", {
    message: err.message,
    stack: err.stack,
  });
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

const cronJobs = require("./jobs/cronJobs");
cronJobs();

async function startServer() {
  try {
    await connectDB();
    await manageIndexes();
    initializeRoutes();
    server.setTimeout(120000);
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
      console.log("Paystack Secret Key Mode:", process.env.NODE_ENV === "production" ? "Live" : "Test");
      console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
    });
  } catch (error) {
    console.error("Failed to start server:", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

startServer();