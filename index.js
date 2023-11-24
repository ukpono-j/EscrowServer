const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
// const compression = require("compression");
// const path = require('path');
const UserModel = require("./modules/Users");
const Transaction = require("./modules/Transactions");
const Notification = require("./modules/Notification");
const NotificationVerification = require("./modules/NotificationVerification");
const MessageModel = require("./modules/Message");
const KYC = require("./modules/Kyc");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const app = express();
const authenticateUser = require("./authenticateUser");
const socket = require("socket.io");
const fs = require("fs");
require("dotenv").config();
const path = require("path");

console.log(process.env.JWT_SECRET);
// app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// app.use(cors());
// app.use(express.static("uploads/images/"));
// app.use("/images", express.static("uploads/images"));

app.use("/images", express.static("./uploads/images"));

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "https://escrow-app.onrender.com",
    "https://escrow-app-delta.vercel.app",
    // " https://escrowserver.onrender.com",
    "https://api.multiavatar.com",
  ],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204,
  allowedHeaders: "Content-Type, Authorization, auth-token",
};

app.use(cors(corsOptions));

mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Successfully connected to MongoDB");
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB: ", error);
  });

// // Set up multer storage and file filter
// const storage = multer.memoryStorage(); // Use memory storage for buffer access
// const fileFilter = (req, file, cb) => {
//   // Check file type, you can customize this based on your requirements
//   const allowedTypes = ["image/jpeg", "image/png", "video/mp4"];
//   if (allowedTypes.includes(file.mimetype)) {
//     cb(null, true);
//   } else {
//     cb(new Error("Invalid file type"), false);
//   }
// };

// // Set up multer middleware
// const upload = multer({
//   storage: storage,
//   fileFilter: fileFilter,
// });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/images");
  },
  filename: (req, file, cb) => {
    // cb(null, file.originalname)
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

// =================== Login

// Set up socket.io with cors options
const io = socket({
  cors: {
    origin: [
      "http://localhost:5173",
      "https://escrow-app.onrender.com",
      "https://escrow-app-delta.vercel.app",
      // " https://escrowserver.onrender.com",
      "https://api.multiavatar.com",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});
app.set("onlineUsers", new Map());
app.set("chatSocket", null);

io.on("connection", (socket) => {
  app.set("chatSocket", socket);

  socket.on("add-user", (userId) => {
    app.get("onlineUsers").set(userId, socket.id);
  });

  socket.on("send-msg", (data) => {
    console.log("sendmsg", { data });

    const sendUserSocketId = app.get("onlineUsers").get(data.to);

    if (sendUserSocketId) {
      // Emit the 'msg-receive' event to the recipient user's socket
      io.to(sendUserSocketId).emit("msg-receive", data.message);

      // If the message contains media, also send it to the recipient
      if (data.message.media) {
        io.to(sendUserSocketId).emit("media-receive", data.message.media);
      }
    }

    // Emit the 'msg-receive' event back to the sender user's socket
    socket.emit("msg-receive", data.message);
  });

  socket.on("disconnect", () => {
    const userIdToRemove = Array.from(app.get("onlineUsers").entries()).find(
      ([key, value]) => value === socket.id
    );

    if (userIdToRemove) {
      app.get("onlineUsers").delete(userIdToRemove[0]);
    }
  });
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Request Body:", req.body);
    console.log("Received login request for email:", email);
    const user = await UserModel.findOne({ email: email });

    console.log("Email:", email);
    console.log("User:", user);

    if (user && bcrypt.compareSync(password, user.password)) {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
      res
        .header("auth-token", token)
        .json({ message: "Login successful!", token });
    } else {
      res.status(401).json({ error: "Invalid Credentials" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ================== Register
app.post("/register", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      bank,
      dateOfBirth,
      accountNumber,
    } = req.body;

    // Check if the email is already registered
    const existingUser = await UserModel.findOne({ email: email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // Hash the password before saving it to the database
    const hashedPassword = bcrypt.hashSync(password, 10);

    // Create a new user record in MongoDB
    const newUser = new UserModel({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      bank,
      accountNumber,
      dateOfBirth,
    });

    // Save the user to the database
    await newUser.save();

    res.status(200).json({ message: "User registered successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to get user details
app.get("/user-details", authenticateUser, async (req, res) => {
  try {
    // Get the user ID from the authenticated user's request object
    const { id: userId } = req.user;

    // Fetch user details from the database based on the user ID
    const user = await UserModel.findById(userId);

    // If the user does not exist, return an error
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return the user details to the client
    res.status(200).json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to get All user details except the current user
app.get("/all-user-details", authenticateUser, async (req, res) => {
  try {
    // Get the current user ID from the authenticated user's request object
    const { id: userId } = req.user;

    // Fetch all user IDs from the database except the current user ID
    const users = await UserModel.find({ _id: { $ne: userId } }).select([
      "email",
      "firstName",
      "avatarImage",
      "_id",
    ]);

    // If there are no other users, return an appropriate response
    if (!users || users.length === 0) {
      return res.status(404).json({ error: "No other users found" });
    }

    // Return the user details to the client
    res.status(200).json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Add this route to handle updating user details
app.put("/update-user-details", authenticateUser, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { firstName, lastName, dateOfBirth, bank, accountNumber } = req.body;

    // Fetch the user from the database
    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update user details
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.bank = bank || user.bank;
    user.accountNumber = accountNumber || user.accountNumber;

    // Save the updated user details
    await user.save();

    res.status(200).json({ message: "User details updated successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle form submission
app.post("/create-transaction", authenticateUser, async (req, res) => {
  try {
    const { id: userId } = req.user;
    const {
      paymentName,
      email: email, // Get the user's email from the request body
      paymentAmount,
      paymentDscription,
      selectedUserType,
      willUseCourier,
      paymentBank,
      paymentAccountNumber,
    } = req.body;

    // Validate that selectedUserType is provided
    // if (!selectedUserType) {
    //   return res.status(400).json({ error: "selectedUserType is required" });
    // }
    const createdAt = new Date();

    // Create a new transaction record in MongoDB
    const newTransaction = new Transaction({
      userId: userId, // Use the authenticated user's ID
      transactionId: uuidv4(),
      paymentName,
      email, // Associate the transaction with the provided email
      paymentAmount,
      paymentDscription,
      selectedUserType,
      willUseCourier,
      paymentBank,
      paymentAccountNumber,
      createdAt: createdAt,
    });

    // Save the transaction to the database
    await newTransaction.save();

    // Return the transaction ID to the client
    res.status(200).json({
      transactionId: newTransaction.transactionId,
      createdAt: createdAt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Fetch User-Specific Transactions:
app.get("/create-transaction", authenticateUser, async (req, res) => {
  try {
    // const userEmail = req.email;

    const { id: userId } = req.user;

    // Fetch transaction details from the database
    const transactions = await Transaction.find({ userId: userId });

    // Fetch transactions where the user has joined
    const joinedTransactions = await Transaction.find({
      "participants.userId": userId,
    });

    // Combine and return both created and joined transactions to the client
    const allTransactions = [...transactions, ...joinedTransactions];
    res.status(200).json(allTransactions);
    // Return the transaction details to the client
    // res.status(200).json(transactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Assuming you have a route like this in your Express app
app.post("/confirm-receipt", authenticateUser, async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Find the transaction for the authenticated user and where proofOfWaybill is false
    const transaction = await Transaction.findOne({
      userId: userId,
      proofOfWaybill: "pending",
    });

    if (!transaction) {
      return res
        .status(404)
        .json({ error: "No pending transactions to confirm" });
    }

    // Update the proofOfWaybill field to 'confirmed'
    transaction.proofOfWaybill = "confirmed";
    await transaction.save();

    // Return a success response
    res.status(200).json({ message: "Receipt confirmed successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Assuming you have a route like this in your Express app
app.post("/update-payment-status", authenticateUser, async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Find the transaction for the authenticated user and where proofOfWaybill is false
    const transaction = await Transaction.findOne({
      userId: userId,
      paymentStatus: "active",
    });

    if (!transaction) {
      return res
        .status(404)
        .json({ error: "No active  transactions to confirm" });
    }

    // Update the proofOfWaybill field to 'confirmed'
    transaction.paymentStatus = "paid";
    await transaction.save();

    // Return a success response
    res.status(200).json({ message: "Payment  successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle joining a transaction
app.post("/join-transaction", authenticateUser, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const { id: userId } = req.user;

    // Find the transaction by ID
    const transaction = await Transaction.findOne({ transactionId });

    // If the transaction does not exist, return an error
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if the user is already a participant in the transaction
    const isParticipant = transaction.participants.some(
      (participant) => participant.userId.toString() === userId.toString()
    );

    if (isParticipant) {
      return res
        .status(400)
        .json({ error: "User is already a participant in this transaction" });
    }

    // Add the user as a participant in the transaction
    transaction.participants.push({ userId });
    await transaction.save();

    // Return success message or the updated transaction object
    res
      .status(200)
      .json({ message: "Successfully joined the transaction", transaction });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle canceling a transaction
app.post("/cancel-transaction", authenticateUser, async (req, res) => {
  try {
    const { transactionId } = req.body;

    // Find the transaction by ID and update its status to "cancelled"
    const cancelledTransaction = await Transaction.findOneAndUpdate(
      { transactionId: transactionId },
      { status: "cancelled" },
      { new: true }
    );

    if (!cancelledTransaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.status(200).json(cancelledTransaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to fetch canceled transactions
app.get("/cancel-transactions", authenticateUser, async (req, res) => {
  try {
    // const userEmail = req.email;

    const { id: userId } = req.user;

    // Fetch canceled transactions from the database
    const cancelledTransactions = await Transaction.find({
      userId: userId,
      status: "cancelled",
    });

    res.status(200).json(cancelledTransactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle marking a transaction as completed
app.post("/complete-transaction", authenticateUser, async (req, res) => {
  try {
    const { transactionId } = req.body;

    // Find the transaction by ID and update its status to "completed"
    const completedTransaction = await Transaction.findOneAndUpdate(
      { transactionId: transactionId },
      { status: "completed" },
      { new: true }
    );

    if (!completedTransaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    res.status(200).json(completedTransaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Endpoint to  fetch completed transaction

app.get("/complete-transaction", authenticateUser, async (req, res) => {
  try {
    // const userEmail = req.email;

    const { id: userId } = req.user;

    // Fetch canceled transactions from the database
    const cancelledTransactions = await Transaction.find({
      userId: userId,
      status: "completed",
    });

    res.status(200).json(cancelledTransactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get notifications for a specific user
// Endpoint to get notifications for a specific user (creator and participants)
app.get("/notifications", authenticateUser, async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Fetch notifications where the user is the creator
    const creatorNotifications = await Notification.find({ userId: userId });

    // Fetch notifications where the user is a participant
    const participantNotifications = await Notification.find({
      "participants.userId": userId,
    });

    // Fetch transactions where the user is a participant
    const joinedTransactions = await Transaction.find({
      "participants.userId": userId,
    });

    // Get notifications for joined transactions by transactionId
    const joinedTransactionNotifications = await Notification.find({
      transactionId: {
        $in: joinedTransactions.map((transaction) => transaction.transactionId),
      },
    });

    // Combine and return both creator and participant notifications to the client
    const allNotifications = [
      ...creatorNotifications,
      ...participantNotifications,
      ...joinedTransactionNotifications,
    ];

    res.status(200).json(allNotifications);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle creating notifications
app.post("/notifications", authenticateUser, async (req, res) => {
  try {
    const { title, message, transactionId } = req.body;
    console.log("Received Notification Request:", req.body);
    const { id: userId } = req.user;

    if (!title || !message || !transactionId) {
      return res.status(400).json({ error: "Title and message are required" });
    }

    // Create a new notification object using the schema
    const newNotification = new Notification({
      userId: userId, // Convert userId to ObjectId
      title: title,
      message: message,
      transactionId: transactionId,
    });

    // Save the notification to the database
    await newNotification.save();

    // Return success response to the client
    res.status(200).json(newNotification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle accepting a transaction
app.post("/accept-transaction", authenticateUser, async (req, res) => {
  try {
    const { notificationId } = req.body;
    const updatedNotification =
      await NotificationVerification.findByIdAndUpdate(
        notificationId,
        { status: "accepted" },
        { new: true }
      );
    res.status(200).json(updatedNotification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to handle declining a transaction
app.post("/decline-transaction", authenticateUser, async (req, res) => {
  try {
    const { notificationId } = req.body;
    const updatedNotification =
      await NotificationVerification.findByIdAndUpdate(
        notificationId,
        { status: "declined" },
        { new: true }
      );
    res.status(200).json(updatedNotification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const getParticipantsForTransaction = async (transactionId) => {
  try {
    const transaction = await Transaction.findById(transactionId);
    if (transaction) {
      return transaction.participants; // Assuming participants is an array of objects containing userIds
    }
    return [];
  } catch (error) {
    console.error("Error fetching participants for transaction:", error);
    return [];
  }
};

app.post(
  "/setAvatar",
  authenticateUser,
  upload.single("image"),
  async (req, res) => {
    try {
      const userId = req.user.id; // Assuming you have user information stored in req.user after authentication
      // const avatarImage = req.file.buffer.toString("base64");
      // const avatarImage = req.file.path;

      const updatedUser = await UserModel.findByIdAndUpdate(
        userId,
        {
          isAvatarImageSet: true,
          avatarImage: req.file.filename,
        },
        { new: true }
      );
      console.log(updatedUser);
      if (updatedUser) {
        res.status(200).json({ success: true, user: updatedUser });
      } else {
        res.status(404).json({ success: false, error: "User not found" });
      }
    } catch (error) {
      console.error("Error setting avatar:", error);
      res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  }
);

// Endpoint for sending messages without media
app.post("/send-message", authenticateUser, async (req, res) => {
  try {
    const { message, from, to } = req.body;
    const { id: userId } = req.user;

    // Create a new message
    const newMessage = new MessageModel({
      message: {
        text: message.text,
        users: [from, to],
        sender: from,
      },
    });

    // Save the message to the database
    await newMessage.save();
    console.log("New message sent:", newMessage);

    res.status(201).json({ message: "Message sent successfully" });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint for fetching messages
app.get("/get-messages", authenticateUser, async (req, res) => {
  try {
    // Get the user ID from the authenticated user's request object
    const { id: userId } = req.user;

    // Get the sender and recipient IDs from the query parameters
    const fromUserId = req.query.from;
    const toUserId = req.query.to;

    // Fetch messages for the user from the database
    const messages = await MessageModel.find({
      $or: [
        {
          "message.users": { $all: [userId, fromUserId, toUserId] }, // Messages between the authenticated user, sender, and recipient
        },
        {
          "message.users": { $all: [userId, toUserId, fromUserId] }, // Messages between the authenticated user, recipient, and sender
        },
      ],
    }).sort({ "message.createdAt": -1 }); // Sort messages by creation date, newest first

    // Map the messages to ensure a consistent structure
    const formattedMessages = messages.map((message) => ({
      _id: message._id,
      sender: message.message.sender, // Access sender property within the message object
      message: {
        text: message.message.text,
        createdAt: message.message.createdAt,
      },
    }));

    // Return the formatted messages to the client
    res.status(200).json(formattedMessages);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// // Endpoint for handling file uploads
// app.post("/chat-message-uploads", authenticateUser, upload.single("media"), async (req, res) => {
//   try {
//     console.log("Received a file upload request");

//     // Get the user ID from the authenticated user's request object
//     const { id: userId } = req.user;
//     console.log("User ID:", userId);

//     // Retrieve the uploaded file information
//     const file = req.file;
//     console.log("Uploaded file:", file);

//     // Convert the buffer to base64 string
//     const base64File = file.buffer.toString('base64');

//     const newMessage = new MessageModel({
//       message: {
//         media: base64File, // Save the file as a base64 string
//         users: [userId],
//         sender: userId,
//       },
//     });

//     // Save the message to the database
//     await newMessage.save();

//     res.status(201).json({ message: "File uploaded successfully", media: base64File, mimeType: file.mimetype  });
//   } catch (error) {
//     console.error("Error uploading file:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// // Endpoint for retrieving messages with media
// app.get("/chat-message-uploads", authenticateUser, async (req, res) => {
//   try {
//     // Retrieve messages with media from the database
//     const messages = await MessageModel.find({ "message.media": { $exists: true } });

//     res.status(200).json(messages);
//   } catch (error) {
//     console.error("Error retrieving messages with media:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// // Endpoint for handling file uploads
// app.post("/chat-message-uploads", authenticateUser, upload.single("media"), async (req, res) => {
//   try {
//     console.log("Received a file upload request");

//     // Get the user ID from the authenticated user's request object
//     const { id: userId } = req.user;
//     console.log("User ID:", userId);

//     // Retrieve the uploaded file information
//     const file = req.file;
//     console.log("Uploaded file:", file);

//     // Convert the buffer to base64 string
//     const base64File = file.buffer.toString('base64');

//     // Extract "to" user ID from the request body
//     const { to, from } = req.body;

//     const newMessage = new MessageModel({
//       message: {
//         media: base64File,
//         users: [from, to], // Include both sender and receiver
//         sender: userId,
//         to: to,
//       },
//     });

//     // Save the message to the database
//     await newMessage.save();

//     res.status(201).json({ message: "File uploaded successfully", media: base64File,  from: userId, to });
//   } catch (error) {
//     console.error("Error uploading file:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// // Endpoint for retrieving messages with media
// app.get("/chat-message-uploads", authenticateUser, async (req, res) => {
//   try {
//     // Get the user ID from the authenticated user's request object
//     const { id: userId } = req.user;

//     const fromUserId = req.query.from;
//     const toUserId = req.query.to;
//     // Retrieve messages with media for the authenticated user
//     const messages = await MessageModel.find({
//       // "message.media": { $exists: true },
//       // "message.users": fromUserId, // Include only messages where the authenticated user is a participant
//       $or: [
//         {
//           "message.users": { $all: [userId, fromUserId, toUserId] }, // Messages between the authenticated user, sender, and recipient
//         },
//         {
//           "message.users": { $all: [userId, toUserId, fromUserId] }, // Messages between the authenticated user, recipient, and sender
//         },
//         { "message.media": { $exists: true },},
//       ],
//     });
//     // Map the messages to ensure a consistent structure
//     const formattedMessages = messages.map((message) => ({
//       _id: message._id,
//       sender: message.message.sender, // Access sender property within the message object
//       message: {
//         // media: message.message.media,
//         media: message.message.media,
//         users:message.message.users,
//         createdAt: message.createdAt,
//       },
//     }));

//     res.status(200).json(formattedMessages);
//   } catch (error) {
//     console.error("Error retrieving messages with media:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// Endpoint for handling file uploads
app.post(
  "/chat-message-uploads",
  authenticateUser,
  upload.single("media"),
  async (req, res) => {
    try {
      console.log("Received a file upload request");

      // Get the user ID from the authenticated user's request object
      const { id: userId } = req.user;
      console.log("User ID:", userId);

      const { to, from } = req.body;

      const newMessage = new MessageModel({
        message: {
          // media: {
          //   data: fs.readFileSync('uploads/images/' +   req.file.filename),
          //   contentType: "image/png",
          // },
          media: req.file.filename,
          users: [from, to], // Include both sender and receiver
          sender: userId,
          to: to,
        },
      });

      // Save the message to the database
      await newMessage.save();

      res.status(201).json("File uploaded successfully");
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

// Endpoint for retrieving messages with media
app.get("/chat-message-uploads", authenticateUser, async (req, res) => {
  try {
    // Get the user ID from the authenticated user's request object
    const { id: userId } = req.user;

    const fromUserId = req.query.from;
    const toUserId = req.query.to;
    // Retrieve messages with media for the authenticated user
    const messages = await MessageModel.find({
      // "message.media": { $exists: true },
      // "message.users": fromUserId, // Include only messages where the authenticated user is a participant
      $or: [
        {
          "message.users": { $all: [userId, fromUserId, toUserId] }, // Messages between the authenticated user, sender, and recipient
        },
        {
          "message.users": { $all: [userId, toUserId, fromUserId] }, // Messages between the authenticated user, recipient, and sender
        },
        { "message.media": { $exists: true } },
      ],
    });
    // Map the messages to ensure a consistent structure
    const formattedMessages = messages.map((message) => ({
      _id: message._id,
      sender: message.message.sender, // Access sender property within the message object
      message: {
        media: {
          filename: message.message.media,
        },
        users: message.message.users,
        createdAt: message.message.createdAt,
      },
    }));

    console.log("formated Message", formattedMessages);

    res.status(200).json(formattedMessages);
  } catch (error) {
    console.error("Error retrieving messages with media:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post(
  "/submit-kyc",
  authenticateUser,
  upload.fields([
    { name: 'documentPhoto', maxCount: 1 },
    { name: 'personalPhoto', maxCount: 1 },
    { name: 'documentType', maxCount: 1 },
    { name: 'firstName', maxCount: 1 },
    { name: 'lastName', maxCount: 1 },
    { name: 'dateOfBirth', maxCount: 1 },
    // Add more fields as needed
  ]),
  async (req, res) => {
    try {
      const userId = req.user.id; // Assuming you have user information stored in req.user after authentication
      // const avatarImage = req.file.buffer.toString("base64");
      // const avatarImage = req.file.path;
      // Extracting relevant information from the request
      const documentType = req.body.documentType;
      const documentPhoto = req.files['documentPhoto'][0].filename;
      const personalPhoto = req.files['personalPhoto'][0].filename;
      const firstName = req.body.firstName;
      const lastName = req.body.lastName;
      const dateOfBirth = req.body.dateOfBirth;

      // Creating a new KYC document
      const kyc = new KYC({
        user: userId,
        documentType: documentType,
        documentPhoto: documentPhoto,
        personalPhoto: personalPhoto,
        firstName: firstName,
        lastName: lastName,
        dateOfBirth: dateOfBirth,
        isSubmitted: true,
      });

      // Save the KYC document
      await kyc.save();
      console.log(kyc);
      res
        .status(201)
        .json({ success: true, message: "KYC submitted successfully" });
    } catch (error) {
      console.error("Error setting avatar:", error);
      res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  }
);

// Route to get KYC details
app.get('/kyc-details', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch KYC details for the user from the database
    const kycDetails = await KYC.findOne({ user: userId });

    if (!kycDetails) {
      return res.status(404).json({ success: false, error: 'KYC details not found', isKycSubmitted: false });
    }

    // Send KYC details and submission status to the client
    res.status(200).json({ success: true, kycDetails, isKycSubmitted: true });
  } catch (error) {
    console.error('Error fetching KYC details:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', isKycSubmitted: false });
  }
});




const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});

// Attach socket.io to the server
io.attach(server);
