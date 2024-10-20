// const express = require("express");
// const app = express();
// const cors = require("cors");
// const socketIo = require("socket.io");
// const http = require("http");
// const connectDB = require('./config/db');
// const authRoutes = require('./routes/authRoutes');
// const userRoutes = require('./routes/userRoutes');
// const transactionRoutes = require('./routes/transactionRoutes');
// const notificationRoutes = require('./routes/notificationRoutes');
// const kycRoutes = require('./routes/kycRoutes');
// const messageRoutes = require('./routes/messages');
// const path = require('path');
// const socket = require("socket.io");
// require("dotenv").config();


// const corsOptions = {
//   origin: [
//     "http://localhost:5173",
//     "https://escrow-app.onrender.com",
//     "https://escrow-app-delta.vercel.app",
//     "https://escrowserver.onrender.com",
//     "https://api.multiavatar.com",
//     "https://mymiddleman.ng",
//   ],
//   // methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
//   methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
//   credentials: true,
//   allowedHeaders: "Content-Type, Authorization, auth-token",
//   optionsSuccessStatus: 204,
// };

// app.use(cors(corsOptions));


// // Manually handle preflight requests
// app.options('*', (req, res) => {
//   res.header('Access-Control-Allow-Origin', 'https://mymiddleman.ng');
//   res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, auth-token');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//   res.header('Access-Control-Allow-Credentials', 'true');
//   res.sendStatus(200);  // Respond with a 200 status for preflight OPTIONS request
// });


// // Set up socket.io with cors options
// const io = socket({
//   cors: {
//     origin: [
//       "http://localhost:5173",
//       "https://escrow-app.onrender.com",
//       "https://escrow-app-delta.vercel.app",
//       "https://escrowserver.onrender.com",
//       "https://api.multiavatar.com",
//       "https://mymiddleman.ng",
//     ],
//     methods: ["GET", "POST"],
//     credentials: true,
//   },
// });

// // Socket.io logic
// // io.on("connection", (socket) => {
// //   console.log("Socket connected:", socket.id);

// //   // Handle chat events here
// //   socket.on("join-room", (roomId, userId) => {
// //     socket.join(roomId);
// //     io.to(roomId).emit("user-connected", userId);

// //     socket.on("message", (message) => {
// //       io.to(roomId).emit("message", message);
// //     });

// //     socket.on("disconnect", () => {
// //       io.to(roomId).emit("user-disconnected", userId);
// //     });
// //   });
// // });

// app.use(express.urlencoded({ extended: false }));

// // app.use("/images", express.static("./uploads/images"));
// app.use('/uploads/images', express.static(path.join(__dirname, 'uploads/images')));



// io.on("connection", (socket) => {
//   console.log("Socket connected:", socket.id);

//   socket.on("join-room", (roomId, userId) => {
//     socket.join(roomId);
//     console.log(`User ${userId} joined room ${roomId}`);

//     socket.on("message", (message) => {
//       io.to(roomId).emit("message", message);
//     });

//     socket.on("disconnect", () => {
//       io.to(roomId).emit("user-disconnected", userId);
//       console.log(`User ${userId} disconnected from room ${roomId}`);
//     });
//   });
// });


// // Connect to the database
// connectDB();

// // Middleware

// app.use(express.json());


// // Routes
// app.use('/api/auth', authRoutes);
// app.use('/api/users', userRoutes);
// app.use('/api/transactions', transactionRoutes);
// app.use('/api/notifications', notificationRoutes);
// app.use('/api/kyc', kycRoutes);
// app.use('/api/messages', messageRoutes);


// const PORT = process.env.PORT || 3001;
//  const server = app.listen(PORT, "0.0.0.0", () => {
//   console.log(`Server is running on port ${PORT}`);
// });

// // Attach socket.io to the server
// io.attach(server);


const express = require("express");
const app = express();
const cors = require("cors");
const socketIo = require("socket.io");
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


// CORS options configuration
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "https://escrow-app.onrender.com",
    "https://escrow-app-delta.vercel.app",
    "https://escrowserver.onrender.com",
    "https://api.multiavatar.com",
    "https://mymiddleman.ng",
  ],
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"], // Allow methods in an array format
  credentials: true,
  // allowedHeaders: "Content-Type, Authorization, auth-token", // Allowed headers
  allowedHeaders: ["Content-Type", "Authorization", "auth-token"],
  optionsSuccessStatus: 204,
};

// Apply CORS middleware at the top of the server setup
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


// Manually handle preflight (OPTIONS) requests for CORS
app.options('*', (req, res) => {
  // res.header('Access-Control-Allow-Origin', 'https://mymiddleman.ng');
  res.header('Access-Control-Allow-Origin', req.headers.origin); 
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, auth-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);  // Send success response for preflight
});

// Middleware for parsing requests
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Static file serving
app.use('/uploads/images', express.static(path.join(__dirname, 'uploads/images')));

// Socket.io setup with CORS
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
    methods: ["GET", "POST"], // Allowed socket methods
    credentials: true,
  },
});

// Socket.io event handling
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

// Routes configuration
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/messages', messageRoutes);

// Start the server and attach socket.io
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
io.attach(server);
