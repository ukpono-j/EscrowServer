const Transaction = require('../modules/Transactions');
const { v4: uuidv4 } = require('uuid');
const User = require("../modules/Users"); // Adjust the path if needed
const mongoose = require("mongoose");
const Chatroom = require('../modules/Chatroom');

exports.createTransaction = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const {
      paymentName,
      email, // Get the user's email from the request body
      paymentAmount,
      paymentDescription,
      selectedUserType,
      willUseCourier,
      paymentBank,
      paymentAccountNumber,
    } = req.body;

    const createdAt = new Date();
    const transactionId = new mongoose.Types.ObjectId();
    // Create a new transaction record in MongoDB
    const newTransaction = new Transaction({
      userId: userId, // Use the authenticated user's ID
      transactionId,
      paymentName,
      email, // Associate the transaction with the provided email
      paymentAmount,
      paymentDescription,
      selectedUserType,
      willUseCourier,
      paymentBank,
      paymentAccountNumber,
      createdAt: createdAt,
    });

    // Save the transaction to the database
    await newTransaction.save();

    // Create a new chatroom associated with the transaction
    const newChatroom = new Chatroom({
      transactionId: newTransaction._id, // Use the transaction's ID
      userId,
      participants: [userId], // Add the transaction creator as a participant
      // You can add additional fields to the chatroom if needed
    });

    // Save the chatroom to the database
    await newChatroom.save();


    // Return the transaction ID to the client
    res.status(200).json({
      transactionId: newTransaction.transactionId,
      createdAt: createdAt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};


exports.getUserTransactions = async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Find transactions where the user is the creator or a participant
    const transactions = await Transaction.find({
      $or: [
        { userId: userId },
        { participants: userId }
      ]
    }).populate('chatroomId'); // Populate chatroomId to get chatroom details

    res.status(200).json(transactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};



exports.completeTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;

    // Find the transaction by ID and update its status to "completed"
    const completedTransaction = await Transaction.findOneAndUpdate(
      { transactionId: transactionId },
      { status: 'completed' },
      { new: true }
    );

    if (!completedTransaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.status(200).json(completedTransaction);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getCompletedTransactions = async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Fetch completed transactions from the database
    const completedTransactions = await Transaction.find({
      userId: userId,
      status: 'completed',
    });

    res.status(200).json(completedTransactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


exports.joinTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const { id: userId } = req.user;

    console.log('Received transactionId:', transactionId);
    console.log('Received userId:', userId);

    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.log('Invalid transaction ID');
      return res.status(400).json({ error: "Invalid transaction ID" });
    }

    const transaction = await Transaction.findOne({ transactionId });
    console.log('Found Transaction:', transaction);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const isParticipant = transaction.participants.some(
      (participant) => participant.toString() === userId.toString()
    );

    if (isParticipant) {
      return res.status(400).json({ error: "User is already a participant in this transaction" });
    }

    transaction.participants.push(userId);
    await transaction.save();

    res.status(200).json({ message: "Successfully joined the transaction", transaction });
  } catch (error) {
    console.error("Error joining transaction:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.updatePaymentStatus = async (req, res) => {
  try {
    const { id: userId } = req.user;

    // Find the transaction for the authenticated user and where paymentStatus is 'active'
    const transaction = await Transaction.findOne({
      userId: userId,
      paymentStatus: 'active',
    });

    if (!transaction) {
      return res.status(404).json({ error: 'No active transactions to confirm' });
    }

    // Update the paymentStatus field to 'paid'
    transaction.paymentStatus = 'paid';
    await transaction.save();

    // Return a success response
    res.status(200).json({ message: 'Payment updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


exports.getTransactionById = async (req, res) => {
  const { id } = req.params;

  try {
    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    res.status(200).json(transaction);
  } catch (error) {
    console.error("Error fetching transaction:", error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getTransactionByChatroomId = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    console.log("Received chatroomId:", chatroomId); // Log the received chatroomId

    if (!mongoose.Types.ObjectId.isValid(chatroomId)) {
      console.log("Invalid chatroomId:", chatroomId); // Log invalid chatroomId case
      return res.status(400).json({ message: "Invalid chatroom ID" });
    }

    const transaction = await Transaction.findOne({ chatroomId: chatroomId })
      .populate('participants')
      .exec();

    if (!transaction) {
      console.log("Transaction not found for chatroomId:", chatroomId); // Log transaction not found
      return res.status(404).json({ message: "Transaction not found" });
    }

    console.log("Transaction found:", transaction); // Log the found transaction
    res.status(200).json(transaction);
  } catch (error) {
    console.error("Error fetching transaction:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.createChatRoom = async (req, res) => {
  const { transactionId } = req.body;
  const userId = req.user.id;

  console.log("Received transactionId:", transactionId);
  console.log("Authenticated userId:", userId);

  
  try {
    // Validate request body
    if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
      console.log("Invalid transaction ID:", transactionId);
      return res.status(400).json({ message: "Invalid transaction ID" });
    }

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.log("Invalid user ID:", userId);
      return res.status(400).json({ message: "Invalid user ID" });
    }

    // Find the transaction
    let transaction = await Transaction.findById(transactionId).populate('participants');
    if (!transaction) {
      console.log("Transaction not found for ID:", transactionId);
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Check if chatroom already exists
    if (transaction.chatroomId) {
      console.log("Chatroom already exists for transaction ID:", transactionId);
      return res.status(200).json({ chatroomId: transaction.chatroomId });
    }

    // Create new chatroom
    const chatroom = new Chatroom({
      transactionId,
      participants: transaction.participants,
    });
    await chatroom.save();

    // Update transaction with chatroom ID
    transaction.chatroomId = chatroom._id;
    await transaction.save();

    res.status(201).json({ chatroomId: chatroom._id });
  } catch (error) {
    console.error("Error creating chatroom:", error); // Log the error
    res.status(500).json({ message: "Internal server error" });
  }
}