const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const UserModel = require("./modules/Users");
const Transaction = require("./modules/Transactions");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const app = express();
const authenticateUser = require("./authenticateUser"); // Import your authenticateUser middleware function

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

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  UserModel.findOne({ email: email }).then((user) => {
    if (user) {
      if (user.password === password) {
        res.json("Success");
      } else {
        res.json("Password is incorrect");
      }
    } else {
      res.json("No record of user");
    }
  });
});

// Register
// app.post("/register", (req, res) => {
//   UserModel.create(req.body)
//     .then((user) => res.json(user))
//     .catch((err) => res.json(err));
// });

app.post("/register", (req, res) => {
  UserModel.create(req.body)
    .then((user) => res.json(user))
    .catch((err) => {
      console.error("Error registering user:", err);
      res
        .status(500)
        .json({ error: "Internal Server Error: Unable to register user" });
    });
});

// Endpoint to handle form submission
app.post("/create-transaction", async (req, res) => {
  try {
    const { paymentName, email, paymentAmount, paymentDscription,selectedUserType, willUseCourier } = req.body;

      // Validate that selectedUserType is provided
      if (!selectedUserType) {
        return res.status(400).json({ error: "selectedUserType is required" });
      }

      
      
    // const userId = req.user.id;
    // Generate a unique transaction ID
    const transactionId = uuidv4();

    // Create a new transaction record in MongoDB
    const newTransaction = new Transaction({
      // userId,
      transactionId,
      paymentName,
      email,
      paymentAmount,
      paymentDscription,
      selectedUserType,
      willUseCourier
    });

    // Save the transaction to the database
    await newTransaction.save();

    // Generate a unique transaction link (for example, using transaction ID and a random string)
    //   const transactionLink = `http://localhost:3001/transactions/${newTransaction._id}-uniquestring`;

    // Store this transaction link in your database, associating it with the newly created transaction record

    // Return the transaction ID   to the client
    res.status(200).json({ transactionId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// app.get("/create-transaction/:transactionId", async (req, res) => {
//     try {
//       const transactionId = req.params.transactionId;
//       const transaction = await Transaction.findOne({ transactionId });
//       if (!transaction) {
//         return res.status(404).json({ error: "Transaction not found" });
//       }
//       res.status(200).json(transaction);
//     } catch (error) {
//       console.error(error);
//       res.status(500).json({ error: "Internal Server Error" });
//     }
//   });

// Fetch User-Specific Transactions:
app.get("/create-transaction", async (req, res) => {
  try {
    // Fetch transaction details from the database
    const transactions = await Transaction.find();

    // Return the transaction details to the client
    res.status(200).json(transactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//   ======================== Linking Transaction
// Endpoint to handle joining a transactions
app.post("/join-transaction/:transactionId", async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { email } = req.body; // Assuming the user's email is sent in the request body

    // Find the transaction by transaction ID in the database
    const transaction = await Transaction.findOne({ transactionId });

    if (!transaction) {
      // If the transaction is not found, return an error response
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Update the transaction record to associate it with the user who joined
    transaction.email = email; // Update with the user's email
    await transaction.save();

    // Return a success response
    res.status(200).json({ message: "Successfully joined the transaction" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
