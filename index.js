const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
// const path = require('path');
const UserModel = require("./modules/Users");
const Transaction = require("./modules/Transactions");
const Notification = require("./modules/Notification");
const NotificationVerification = require("./modules/NotificationVerification");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const app = express();
const authenticateUser = require("./authenticateUser"); 
require("dotenv").config(); 


console.log(process.env.JWT_SECRET);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// app.use(cors());

const corsOptions = {
  origin: ["http://localhost:5173", "https://escrow-app.onrender.com", "https://escrow-app-delta.vercel.app"],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE", 
  credentials: true, 
  optionsSuccessStatus: 204, 
  allowedHeaders: "Content-Type, Authorization, auth-token",
};


app.use(cors(corsOptions)); 

mongoose
.connect(process.env.MONGODB_URI,
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    }
  )
  .then(() => {
    console.log("Successfully connected to MongoDB");
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB: ", error);
  });



// =================== Login

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
    const { firstName, lastName, email, password, bank, dateOfBirth,  accountNumber } = req.body;

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
      dateOfBirth
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
// app.get("/notifications", authenticateUser, async (req, res) => {
//   try {
//     const { id: userId } = req.user;
    
//     const notifications = await Notification.find({ userId: userId });
//     res.status(200).json(notifications);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

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
      transactionId: { $in: joinedTransactions.map(transaction => transaction.transactionId) }
    });

    // Combine and return both creator and participant notifications to the client
    const allNotifications = [
      ...creatorNotifications,
      ...participantNotifications,
      ...joinedTransactionNotifications
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

// Get notifications for a specific user
// app.get("/verify-notifications", authenticateUser, async (req, res) => {
//   try {
//     const { id: userId } = req.user;
//     const notifications = await NotificationVerification.find({ userId: userId });
//     res.status(200).json(notifications);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// Get notifications for a specific user (creator and participants)
// app.get("/verify-notifications", authenticateUser, async (req, res) => {
//   try {
//     const { id: userId } = req.user;

//     // Fetch notifications where the user is the creator
//     const creatorNotifications = await NotificationVerification.find({
//       userId: userId,
//     });

//     // Fetch notifications where the user is a participant
//     const participantNotifications = await NotificationVerification.find({
//       "participants.userId": userId,
//     });

//     // Combine and return both creator and participant notifications to the client
//     const allNotifications = [
//       ...creatorNotifications,
//       ...participantNotifications,
//     ];
//     res.status(200).json(allNotifications);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

// Define the getParticipantsForTransaction function
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

// Endpoint to handle creating notifications with participants
// app.post("/verify-notifications", authenticateUser, async (req, res) => {
//   try {
//     const { title, message, transactionId } = req.body;
//     const { id: userId } = req.user;

//     if (!title || !message || !transactionId) {
//       return res
//         .status(400)
//         .json({ error: "Title, message, and transactionId are required" });
//     }

//     // Get participants for the given transactionId
//     const participants = await getParticipantsForTransaction(userId);

//     // Create a new notification object with participants
//     const newNotificationVerification = new NotificationVerification({
//       userId: userId,
//       title: title,
//       message: message,
//       transactionId: transactionId,
//       participants: participants.map((participant) => participant.userId),
//     });

//     // Save the notification to the database
//     await newNotificationVerification.save();

//     // Return success response to the client
//     res.status(200).json(newNotificationVerification);
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0',  () => {
  console.log(`Server is running on port ${PORT}`);
});
