const express = require("express");
const app = express();
const cors = require("cors");
// const socketIo = require("socket.io");
const http = require("http");
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const kycRoutes = require('./routes/kycRoutes');
const messageRoutes = require('./routes/messages');
const path = require('path');
const socket = require("socket.io");
require("dotenv").config();



const corsOptions = {
  // origin: [
  //   "https://mymiddleman.ng",
  //   "http://localhost:5173",
  //   "https://escrow-app.onrender.com",
  //   "https://escrow-app-delta.vercel.app",
  //   "https://escrowserver.onrender.com",
  //   "https://api.multiavatar.com",
  // ],
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  credentials: false,
  allowedHeaders: "Content-Type, Authorization, auth-token, x-auth-token",
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

app.use(function (request, response, next) {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, auth-token, x-auth-token");
  next();
});

// Set up socket.io with cors options
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

// Socket.io logic
// io.on("connection", (socket) => {
//   console.log("Socket connected:", socket.id);

//   // Handle chat events here
//   socket.on("join-room", (roomId, userId) => {
//     socket.join(roomId);
//     io.to(roomId).emit("user-connected", userId);

//     socket.on("message", (message) => {
//       io.to(roomId).emit("message", message);
//     });

//     socket.on("disconnect", () => {
//       io.to(roomId).emit("user-disconnected", userId);
//     });
//   });
// });

app.use(express.urlencoded({ extended: false }));

// app.use("/images", express.static("./uploads/images"));
app.use('/uploads/images', express.static(path.join(__dirname, 'uploads/images')));




io.on("connection", (socket) => {
  // console.log("Socket connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    // console.log(`User ${userId} joined room ${roomId}`);

    socket.on("message", (message) => {
      io.to(roomId).emit("message", message);
    });

    socket.on("disconnect", () => {
      io.to(roomId).emit("user-disconnected", userId);
      // console.log(`User ${userId} disconnected from room ${roomId}`);
    });
  });
});


// Connect to the database
connectDB();

// Middleware

app.use(express.json());


// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/messages', messageRoutes);



const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, "0.0.0.0", () => {
  // console.log(`Server is running on port ${PORT}`);
});

// Attach socket.io to the server
io.attach(server);
