const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const UserModel = require("./modules/Users");
const Transaction = require("./modules/Transactions");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const app = express();
const authenticateUser = require("./authenticateUser"); // Import your authenticateUser middleware function
require("dotenv").config(); // Load environment variables from .env file

console.log(process.env.JWT_SECRET);

app.use(express.json());
app.use(cors());

mongoose
  .connect(
    "mongodb+srv://zeek:Outside2021@escrow0.4bjhmuq.mongodb.net/?retryWrites=true&w=majority",
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
    const { firstName, lastName, email, password } = req.body;

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
    } = req.body;

    // Validate that selectedUserType is provided
    // if (!selectedUserType) {
    //   return res.status(400).json({ error: "selectedUserType is required" });
    // }

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
    });

    // Save the transaction to the database
    await newTransaction.save();

    // Return the transaction ID to the client
    res.status(200).json({ transactionId: newTransaction.transactionId });
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
// Backend: Modify join-transaction endpoint
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
    res.status(200).json({ message: "Successfully joined the transaction", transaction });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});



const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
