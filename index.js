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


// const corsOptions = {
//   // origin: [
//   //   "https://mymiddleman.ng",
//   //   "http://localhost:5173",
//   //   "https://escrow-app.onrender.com",
//   //   "https://escrow-app-delta.vercel.app",
//   //   "https://escrowserver.onrender.com",
//   //   "https://api.multiavatar.com",
//   // ],
//   // origin: "*",
//   // methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
//   // credentials: false,
//   // allowedHeaders: "Content-Type, Authorization, auth-token",
//   // optionsSuccessStatus: 204,
// };

// app.use(cors(corsOptions));

// **Add middleware to log CORS headers**
// app.use((req, res, next) => {
//   console.log(`Request received for ${req.url}`); // Log incoming request
//   res.on('finish', () => {
//     console.log("CORS Headers Sent:", res.get('Access-Control-Allow-Origin'));
//     console.log("Full Headers:", res.getHeaders()); // Logs all headers
//   });
//   next();
// });

// Catch unhandled errors and log CORS headers in the case of errors
app.use((err, req, res, next) => {
  console.error("Error occurred:", err);
  res.status(500).send("Internal Server Error");
  next(err);  // ensure headers logging still happens on errors
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
  console.log("Socket connected:", socket.id);

  socket.on("join-room", (roomId, userId) => {
    socket.join(roomId);
    console.log(`User ${userId} joined room ${roomId}`);

    socket.on("message", (message) => {
      io.to(roomId).emit("message", message);
    });

    socket.on("disconnect", () => {
      io.to(roomId).emit("user-disconnected", userId);
      console.log(`User ${userId} disconnected from room ${roomId}`);
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
  console.log(`Server is running on port ${PORT}`);
});

// Attach socket.io to the server
io.attach(server);
