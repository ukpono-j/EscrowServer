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
const logger = require("morgan"); // Added for request logging
require("dotenv").config();
const cloudinary = require('cloudinary').v2;
const responseFormatter = require("./middlewares/responseFormatter");
const Transaction = require("./modules/Transactions");
const Chatroom = require("./modules/Chatroom");
const User = require("./modules/Users");
const Message = require("./modules/Message");
const Dispute = require("./modules/Dispute"); // Added for dispute-related operations
const DisputeMessage = require("./modules/DisputeMessage"); // Added for dispute messages
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger-output.json');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure webpush for notifications
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
      "https://mymiddleman.ng",
      "https://1ea518b60f04.ngrok-free.app",
      "http://localhost:3001",
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

// Request logging middleware (for development)
if (process.env.NODE_ENV === 'development') {
  app.use(logger('dev'));
}

// Environment variable validation
const requiredEnvVars = [
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "MONGODB_URI",
  process.env.NODE_ENV === "production" ? "PAYSTACK_LIVE_SECRET_KEY" : "PAYSTACK_SECRET_KEY",
  "PAYSTACK_API_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "VAPID_MAILTO",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
];

const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error("Missing required environment variables:", missingEnvVars);
  process.exit(1);
}

const PAYSTACK_SECRET_KEY = process.env.NODE_ENV === "production"
  ? process.env.PAYSTACK_LIVE_SECRET_KEY
  : process.env.PAYSTACK_SECRET_KEY;

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// Manage MongoDB indexes
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

// CORS configuration
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

// Log response headers
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`Response for ${req.method} ${req.url}:`, res.getHeaders());
  });
  next();
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Authentication error: No token provided"));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.id) {
      return next(new Error("Authentication error: Invalid token payload"));
    }

    // Fetch user to get admin status
    const user = await User.findById(decoded.id).select('isAdmin firstName lastName');
    if (!user) {
      return next(new Error("Authentication error: User not found"));
    }

    socket.user = {
      id: decoded.id,
      isAdmin: user.isAdmin || false,
      firstName: user.firstName,
      lastName: user.lastName
    };
    socket.join(`user_${decoded.id}`);

    console.log("Socket authenticated successfully:", {
      userId: decoded.id,
      isAdmin: user.isAdmin,
      socketId: socket.id,
      time: new Date().toISOString(),
    });
    next();
  } catch (error) {
    return next(new Error(`Authentication error: ${error.message}`));
  }
});

// Socket.IO event handlers
const setupSocket = (io) => {
  io.on("connection", (socket) => {
    console.log("User connected:", {
      userId: socket.user.id,
      socketId: socket.id,
      clientIp: socket.handshake.address,
      time: new Date().toISOString(),
    });

    // DISPUTE ROOM JOINING - Enhanced to match your controller logic
    socket.on("join-dispute-room", async (disputeId, userId) => {
      try {
        console.log("🔌 USER ATTEMPTING TO JOIN DISPUTE ROOM:", {
          disputeId,
          userId,
          socketId: socket.id,
          isAdmin: socket.user.isAdmin,
          timestamp: new Date().toISOString()
        });

        if (!mongoose.Types.ObjectId.isValid(disputeId) || !mongoose.Types.ObjectId.isValid(userId)) {
          console.log("❌ INVALID IDS:", { disputeId, userId });
          socket.emit("error", { message: "Invalid dispute or user ID" });
          return;
        }

        // Find dispute with populated transaction data (matching your controller approach)
        const dispute = await Dispute.findById(disputeId)
          .populate({
            path: 'transactionId',
            select: 'userId participants selectedUserType reference',
            populate: [
              { path: 'userId', select: '_id firstName lastName' },
              { path: 'participants.userId', select: '_id firstName lastName' }
            ]
          });

        if (!dispute) {
          console.log("❌ DISPUTE NOT FOUND:", disputeId);
          socket.emit("error", { message: "Dispute not found" });
          return;
        }

        // ENHANCED: Authorization check matching your controller logic
        const transaction = dispute.transactionId;
        const isCreator = transaction.userId._id.toString() === userId;
        const isParticipant = transaction.participants.some(p =>
          p.userId && p.userId._id.toString() === userId
        );

        // Allow dispute creator, transaction creator, transaction participants, AND admins
        const hasAccess = isCreator || isParticipant || socket.user.isAdmin || dispute.userId.toString() === userId;

        if (!hasAccess) {
          console.log("❌ UNAUTHORIZED ROOM JOIN:", {
            userId,
            disputeId,
            isCreator,
            isParticipant,
            isAdmin: socket.user.isAdmin,
            disputeCreator: dispute.userId.toString()
          });
          socket.emit("error", { message: "Unauthorized to join this dispute room" });
          return;
        }

        socket.join(`dispute_${disputeId}`);

        console.log("✅ USER JOINED DISPUTE ROOM:", {
          userId,
          disputeId,
          isAdmin: socket.user.isAdmin,
          isCreator,
          isParticipant,
          socketId: socket.id,
          timestamp: new Date().toISOString()
        });

        socket.emit("dispute-room-joined", { disputeId, userId });

      } catch (error) {
        console.error("❌ ERROR JOINING DISPUTE ROOM:", {
          disputeId,
          userId,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        socket.emit("error", { message: "Failed to join dispute room" });
      }
    });

    // DISPUTE MESSAGE HANDLER - This should NOT save messages (your controller handles that)
    // This is only for real-time broadcasting of already saved messages
    socket.on("disputeMessage", async (messageData) => {
      try {
        console.log("📨 SOCKET DISPUTE MESSAGE RECEIVED:", {
          disputeId: messageData.disputeId,
          userId: messageData.userId,
          socketId: socket.id,
          timestamp: new Date().toISOString()
        });

        if (!mongoose.Types.ObjectId.isValid(messageData.disputeId)) {
          console.error("❌ Invalid dispute ID in socket message:", messageData.disputeId);
          socket.emit("error", { message: "Invalid dispute ID" });
          return;
        }

        // Verify the dispute exists and user has access
        const dispute = await Dispute.findById(messageData.disputeId)
          .populate({
            path: 'transactionId',
            select: 'userId participants selectedUserType',
            populate: [
              { path: 'userId', select: '_id' },
              { path: 'participants.userId', select: '_id' }
            ]
          });

        if (!dispute) {
          console.error("❌ Dispute not found for socket message:", messageData.disputeId);
          socket.emit("error", { message: "Dispute not found" });
          return;
        }

        // Authorization check
        const transaction = dispute.transactionId;
        const isCreator = transaction.userId._id.toString() === messageData.userId;
        const isParticipant = transaction.participants.some(p =>
          p.userId && p.userId._id.toString() === messageData.userId
        );
        const hasAccess = isCreator || isParticipant || socket.user.isAdmin || dispute.userId.toString() === messageData.userId;

        if (!hasAccess) {
          console.error("❌ Unauthorized socket message attempt:", {
            userId: messageData.userId,
            disputeId: messageData.disputeId
          });
          socket.emit("error", { message: "Unauthorized to send message to this dispute" });
          return;
        }

        // Broadcast the message to the dispute room
        // Note: The actual message saving is handled by your disputeController.sendDisputeMessage
        io.to(`dispute_${messageData.disputeId}`).emit("disputeMessage", messageData);

        console.log("📡 DISPUTE MESSAGE BROADCASTED:", {
          disputeId: messageData.disputeId,
          userId: messageData.userId,
          room: `dispute_${messageData.disputeId}`,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error("❌ ERROR HANDLING DISPUTE MESSAGE:", {
          disputeId: messageData.disputeId,
          userId: messageData.userId,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        socket.emit("error", { message: "Failed to broadcast dispute message" });
      }
    });

    // DISPUTE STATUS UPDATE - Enhanced for admin actions
    socket.on("disputeStatusUpdate", async ({ disputeId, status }) => {
      try {
        console.log("🔄 DISPUTE STATUS UPDATE REQUEST:", {
          disputeId,
          status,
          userId: socket.user.id,
          isAdmin: socket.user.isAdmin,
          timestamp: new Date().toISOString()
        });

        if (!mongoose.Types.ObjectId.isValid(disputeId)) {
          console.error("❌ Invalid dispute ID for status update:", disputeId);
          socket.emit("error", { message: "Invalid dispute ID" });
          return;
        }

        if (!socket.user.isAdmin) {
          console.error("❌ Unauthorized dispute status update attempt:", {
            userId: socket.user.id,
            disputeId
          });
          socket.emit("error", { message: "Unauthorized to update dispute status" });
          return;
        }

        const dispute = await Dispute.findById(disputeId)
          .populate({
            path: 'transactionId',
            select: 'userId participants reference',
            populate: [
              { path: 'userId', select: '_id' },
              { path: 'participants.userId', select: '_id' }
            ]
          });

        if (!dispute) {
          console.error("❌ Dispute not found for status update:", disputeId);
          socket.emit("error", { message: "Dispute not found" });
          return;
        }

        // Update the dispute status
        dispute.status = status;
        await dispute.save();

        // Broadcast to dispute room and all involved users
        const transaction = dispute.transactionId;
        const involvedUserIds = [
          transaction.userId._id.toString(),
          ...transaction.participants.map(p => p.userId._id.toString())
        ].filter((userId, index, self) => self.indexOf(userId) === index);

        // Broadcast to dispute room
        io.to(`dispute_${disputeId}`).emit("disputeStatusUpdate", { disputeId, status });

        // Also broadcast to individual user rooms
        involvedUserIds.forEach(userId => {
          io.to(`user_${userId}`).emit("disputeStatusUpdate", { disputeId, status });
        });

        console.log("✅ DISPUTE STATUS UPDATED AND BROADCASTED:", {
          disputeId,
          status,
          adminUserId: socket.user.id,
          involvedUsers: involvedUserIds.length,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error("❌ ERROR UPDATING DISPUTE STATUS:", {
          disputeId,
          status,
          adminUserId: socket.user.id,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
        socket.emit("error", { message: "Failed to update dispute status" });
      }
    });

    // TYPING INDICATORS for disputes
    socket.on("userTyping", async (data) => {
      try {
        if (!mongoose.Types.ObjectId.isValid(data.disputeId) || !mongoose.Types.ObjectId.isValid(data.userId)) {
          console.error("❌ Invalid typing data:", data);
          return;
        }

        // Verify dispute access
        const dispute = await Dispute.findById(data.disputeId)
          .populate({
            path: 'transactionId',
            select: 'userId participants',
            populate: [
              { path: 'userId', select: '_id' },
              { path: 'participants.userId', select: '_id' }
            ]
          });

        if (!dispute) {
          console.error("❌ Dispute not found for typing:", data.disputeId);
          return;
        }

        // Authorization check
        const transaction = dispute.transactionId;
        const isCreator = transaction.userId._id.toString() === data.userId;
        const isParticipant = transaction.participants.some(p =>
          p.userId && p.userId._id.toString() === data.userId
        );
        const hasAccess = isCreator || isParticipant || socket.user.isAdmin || dispute.userId.toString() === data.userId;

        if (!hasAccess) {
          console.error("❌ Unauthorized typing in dispute:", {
            userId: data.userId,
            disputeId: data.disputeId
          });
          return;
        }

        // Broadcast typing indicator
        socket.to(`dispute_${data.disputeId}`).emit("userTyping", {
          userId: data.userId,
          disputeId: data.disputeId,
          userName: data.userName || `${socket.user.firstName} ${socket.user.lastName}`.trim()
        });

        console.log("⌨️ USER TYPING BROADCASTED:", {
          userId: data.userId,
          disputeId: data.disputeId,
          userName: data.userName
        });

      } catch (error) {
        console.error("❌ ERROR BROADCASTING TYPING:", {
          data,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    socket.on("userStoppedTyping", async (data) => {
      try {
        if (!mongoose.Types.ObjectId.isValid(data.disputeId) || !mongoose.Types.ObjectId.isValid(data.userId)) {
          console.error("❌ Invalid stop-typing data:", data);
          return;
        }

        // Quick verification that dispute exists
        const dispute = await Dispute.findById(data.disputeId);
        if (!dispute) return;

        // Broadcast stop typing
        socket.to(`dispute_${data.disputeId}`).emit("userStoppedTyping", {
          userId: data.userId,
          disputeId: data.disputeId
        });

        console.log("⌨️ USER STOPPED TYPING BROADCASTED:", {
          userId: data.userId,
          disputeId: data.disputeId
        });

      } catch (error) {
        console.error("❌ ERROR BROADCASTING STOP-TYPING:", {
          data,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // DISPUTE NOTIFICATIONS - For real-time dispute creation/updates
    socket.on("disputeCreated", (data) => {
      try {
        console.log("🔔 DISPUTE CREATED NOTIFICATION:", {
          disputeId: data.disputeId,
          createdBy: data.createdBy,
          timestamp: new Date().toISOString()
        });

        // Broadcast to all admin users
        io.emit("disputeCreated", data);

        // Also broadcast to specific users if provided
        if (data.notifyUserIds && Array.isArray(data.notifyUserIds)) {
          data.notifyUserIds.forEach(userId => {
            io.to(`user_${userId}`).emit("disputeCreated", data);
          });
        }

      } catch (error) {
        console.error("❌ ERROR BROADCASTING DISPUTE CREATED:", {
          data,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Keep your existing chatroom handlers unchanged...
    socket.on("join-room", async (room, userId) => {
      // Your existing join-room logic for transactions
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

    // Keep all your existing handlers for regular chat, balance updates, etc.
    socket.on("message", async (message) => {
      // Your existing message handler for regular chat
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

    // Keep your other existing handlers
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

// Middleware setup
app.set("timeout", 60000);
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.json());
app.use(responseFormatter);

// Serve Swagger UI
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
    const disputeRoutes = require("./routes/disputeRoutes");

    app.use("/api/auth", authRoutes);
    app.use("/api/users", userRoutes);
    app.use("/api/transactions", transactionRoutes);
    app.use("/api/notifications", notificationRoutes);
    app.use("/api/kyc", kycRoutes);
    app.use("/api/wallet", walletRoutes);
    app.use("/api/messages", messageRoutes);
    app.use("/api/admin", adminRoutes);
    app.use("/api/disputes", disputeRoutes);

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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server Error:", {
    message: err.message,
    stack: err.stack,
    time: new Date().toISOString(),
  });
  res.status(err.status || 500).json({
    error: "Internal Server Error",
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// Start cron jobs
const cronJobs = require("./jobs/cronJobs");
cronJobs();

// Start server
async function startServer() {
  try {
    await connectDB();
    await manageIndexes();
    initializeRoutes();
    server.setTimeout(120000);
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
      console.log("Environment:", process.env.NODE_ENV || "development");
      console.log("Paystack Secret Key Mode:", process.env.NODE_ENV === "production" ? "Live" : "Test");
      console.log("CORS origins:", corsOptions.origin);
      console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
    });
  } catch (error) {
    console.error("Failed to start server:", {
      message: error.message,
      stack: error.stack,
      time: new Date().toISOString(),
    });
    process.exit(1);
  }
}

startServer();