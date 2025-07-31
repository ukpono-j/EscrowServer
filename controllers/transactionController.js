const Transaction = require("../modules/Transactions");
const User = require("../modules/Users");
const Chatroom = require("../modules/Chatroom");
const Wallet = require("../modules/wallet");
const Notification = require("../modules/Notification");
const mongoose = require("mongoose");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const nigeriaBanks = require("../data/banksList");
const { getBankNameFromCode } = require('../data/banksList');
const cache = require("../cache");
const NodeCache = require('node-cache');
// const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10min TTL
const fs = require("fs");


// Ensure the Uploads directory exists
const uploadDir = path.join(__dirname, "../Uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}


exports.createTransaction = async (req, res) => {
  const {
    paymentName,
    email,
    paymentAmount,
    paymentDescription,
    selectedUserType,
    paymentBank = "Pending",
    paymentBankCode = "000",
    paymentAccountNumber = "0",
  } = req.body;
  const userId = req.user.id;

  try {
    // Validate required fields
    if (!paymentName || !email || !paymentAmount || !paymentDescription || !selectedUserType) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // Validate selectedUserType
    if (!['buyer', 'seller'].includes(selectedUserType)) {
      return res.status(400).json({ success: false, error: "Invalid user type" });
    }

    // Check cache for user
    const cacheKey = `user_${userId}`;
    let user = cache.get(cacheKey);
    if (!user) {
      user = await User.findById(userId);
      if (!user) {
        console.log("User not found:", userId);
        return res.status(404).json({ success: false, error: "User not found" });
      }
      cache.set(cacheKey, user);
    }

    // Check cache for wallet
    const walletCacheKey = `wallet_${userId}`;
    let wallet = cache.get(walletCacheKey);
    if (!wallet) {
      wallet = await Wallet.findOne({ userId });
      if (!wallet) {
        console.log("Wallet not found, creating new wallet for user:", userId);
        wallet = new Wallet({
          userId,
          balance: 0,
          totalDeposits: 0,
          currency: "NGN",
          transactions: [],
        });
        await wallet.save();
        console.log("New wallet created:", wallet._id);
        cache.set(walletCacheKey, wallet);
      }
    }

    // Create transaction
    const transaction = new Transaction({
      userId,
      paymentName,
      paymentBank,
      paymentAccountNumber,
      email,
      paymentAmount: parseFloat(paymentAmount),
      productDetails: {
        description: paymentDescription,
        amount: parseFloat(paymentAmount),
      },
      selectedUserType,
      paymentBankCode,
      buyerWalletId: selectedUserType === "buyer" ? wallet._id : null,
      sellerWalletId: selectedUserType === "seller" ? wallet._id : null,
      status: "pending",
      participants: [],
    });

    console.log("Transaction object prepared:", {
      userId,
      paymentName,
      email,
      paymentAmount,
      paymentDescription,
      selectedUserType,
    });

    // Save transaction
    await transaction.save();
    console.log("Transaction saved successfully:", transaction._id);

    // Create notification
    const creatorNotification = new Notification({
      userId,
      title: "Transaction Created",
      message: `You have successfully created a transaction ${transaction._id} as ${selectedUserType}.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "pending",
    });
    await creatorNotification.save();
    console.log("Notification created for creator:", creatorNotification._id);

    // Emit socket event
    const io = req.app.get("io");
    io.to(userId).emit("transactionCreated", {
      transactionId: transaction._id.toString(),
      message: `Transaction created successfully as ${selectedUserType}`,
    });
    console.log("Emitted transactionCreated event to user:", userId);

    return res.status(201).json({
      success: true,
      data: { message: "Transaction created successfully", transactionId: transaction._id.toString() },
    });
  } catch (error) {
    console.error("Error creating transaction:", {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.verifyBankAccount = async (req, res) => {
  const { account_number, bank_code } = req.body;

  try {
    // Validate inputs
    if (!account_number || account_number.length !== 10 || !/^\d{10}$/.test(account_number)) {
      return res.status(422).json({
        success: false,
        error: "Account number must be a 10-digit number",
      });
    }
    if (!bank_code) {
      return res.status(422).json({
        success: false,
        error: "Bank code is required",
      });
    }

    // Get bank name from code
    const bank_name = getBankNameFromCode(bank_code);
    if (bank_name === "Unknown Bank") {
      console.log("Invalid bank code provided:", bank_code);
      return res.status(422).json({
        success: false,
        error: "Invalid bank code",
      });
    }

    // Determine Paystack key based on environment
    const paystackKey =
      process.env.NODE_ENV === "production"
        ? process.env.PAYSTACK_LIVE_SECRET_KEY
        : process.env.PAYSTACK_SECRET_KEY;

    if (!paystackKey) {
      console.error("Paystack key is missing for NODE_ENV:", process.env.NODE_ENV);
      return res.status(500).json({
        success: false,
        error: "Server configuration error: Paystack key missing",
      });
    }

    // Paystack bank account verification
    const response = await axios.get(
      `${process.env.PAYSTACK_API_URL}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: {
          Authorization: `Bearer ${paystackKey}`,
        },
        timeout: 10000,
      }
    );

    console.log("Paystack verification response:", response.data);

    if (response.data.status && response.data.data.account_name) {
      return res.status(200).json({
        success: true,
        data: {
          status: true,
          account_name: response.data.data.account_name,
          bank_name,
        },
      });
    } else {
      console.log("Paystack verification failed:", response.data.message);
      return res.status(422).json({
        success: false,
        error: response.data.message || "Unable to verify account",
      });
    }
  } catch (error) {
    console.error("Bank verification error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      bank_code,
      account_number,
    });
    let errorMessage = "Failed to verify account. Please try again.";
    if (error.message.includes("localStorage is not defined")) {
      errorMessage = "Server error: Invalid bank list configuration";
    } else if (error.response) {
      if (error.response.status === 401) {
        errorMessage = "Invalid Paystack API key";
      } else if (error.response.status === 404) {
        errorMessage = "Account not found with provided details";
      } else if (error.response.status === 400) {
        errorMessage = "Invalid account number or bank code";
      } else {
        errorMessage = error.response.data?.message || errorMessage;
      }
    } else if (error.code === "ECONNABORTED") {
      errorMessage = "Request timed out. Please check your network connection.";
    } else if (error.code === "ENOTFOUND") {
      errorMessage = "Unable to connect to Paystack API. Please check the API URL.";
    }
    return res.status(error.response?.status || 500).json({
      success: false,
      error: errorMessage,
    });
  }
};

exports.getBanks = async (req, res) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) {
      return res.status(401).json({ success: false, error: "Authorization token required" });
    }

    const cacheKey = "banks_list";
    let banks = cache.get(cacheKey);
    if (banks) {
      console.log("Returning cached banks:", banks.length);
      return res.status(200).json({ success: true, data: banks });
    }

    // Fetch from Paystack
    const paystackResponse = await axios.get("https://api.paystack.co/bank?country=nigeria", {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
      timeout: 10000,
    });

    banks = paystackResponse.data.status && Array.isArray(paystackResponse.data.data) && paystackResponse.data.data.length > 0
      ? paystackResponse.data.data.map((bank) => ({
        name: bank.name,
        code: bank.code,
      }))
      : nigeriaBanks;

    cache.set(cacheKey, banks, 3600); // Cache for 1 hour
    return res.status(200).json({ success: true, data: banks });
  } catch (error) {
    console.error("Error fetching banks:", error);
    return res.status(200).json({
      success: true,
      data: nigeriaBanks,
      warning: "Failed to fetch banks from external API, using default list",
    });
  }
};

exports.getUserAndWallet = async (req, res) => {
  const userId = req.user.id;
  const cacheKey = `user_wallet_${userId}`;

  try {
    let data = cache.get(cacheKey);
    if (data) {
      console.log("Returning cached user and wallet data:", userId);
      return res.status(200).json({ success: true, data });
    }

    const [user, wallet] = await Promise.all([
      User.findById(userId).select("firstName lastName email phoneNumber"),
      Wallet.findOne({ userId }).select("balance currency transactions"),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    data = {
      user: user || null,
      wallet: wallet || { balance: 0, currency: "NGN", transactions: [] },
    };

    cache.set(cacheKey, data, 600); // Cache for 10 minutes
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error fetching user and wallet:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.getUserTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    console.log("Fetching transactions for user:", userId, { page, limit });
    const [transactions, total] = await Promise.all([
      Transaction.find({
        $or: [{ userId }, { participants: userId }],
      })
        .populate("userId", "firstName lastName email")
        .populate("participants", "firstName lastName email")
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({
        $or: [{ userId }, { participants: userId }],
      }),
    ]);

    const cleanedTransactions = transactions.map((t) => {
      const isCreator = t.userId._id.toString() === userId;
      const isParticipant = t.participants.some((p) => p && p._id.toString() === userId);
      const userRole = isCreator
        ? t.selectedUserType
        : t.selectedUserType === "buyer"
          ? "seller"
          : "buyer";

      t.participants = t.participants.filter((p) => p && p._id && p.email);

      return {
        ...t,
        userRole,
      };
    });

    console.log("Transactions fetched:", cleanedTransactions.length, "Response data:", cleanedTransactions);
    return res.status(200).json({
      success: true,
      data: cleanedTransactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.getCompletedTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({
        $or: [{ userId }, { participants: userId }],
        status: "completed",
      })
        .populate("userId", "firstName lastName email")
        .populate("participants", "firstName lastName email")
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({
        $or: [{ userId }, { participants: userId }],
        status: "completed",
      }),
    ]);

    console.log('Completed transactions fetched:', transactions.length);
    return res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching completed transactions:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(id)
      .populate("userId", "firstName lastName email avatarImage")
      .populate("participants", "firstName lastName email avatarImage");

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    const canPreview = transaction.status === "pending" && transaction.participants.length === 0;

    if (!isCreator && !isParticipant && !canPreview) {
      return res.status(403).json({ success: false, error: "Unauthorized to view this transaction" });
    }

    if (!isCreator && !isParticipant && canPreview) {
      const limitedTransaction = {
        _id: transaction._id,
        userId: {
          firstName: transaction.userId.firstName,
          lastName: transaction.userId.lastName,
          email: transaction.userId.email,
          avatarImage: transaction.userId.avatarImage,
        },
        productDetails: {
          description: transaction.productDetails.description,
        },
        paymentAmount: transaction.paymentAmount,
        status: transaction.status,
        selectedUserType: transaction.selectedUserType,
      };
      return res.status(200).json({ success: true, data: limitedTransaction });
    }

    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    console.error("Error fetching transaction by ID:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.cancelTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(id).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);

    if (!isCreator && !isParticipant) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Unauthorized to cancel this transaction" });
    }

    if (transaction.status !== "pending") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Only pending transactions can be cancelled" });
    }

    let refundedAmount = 0;
    if (transaction.locked && transaction.buyerWalletId && transaction.lockedAmount > 0) {
      const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
      if (buyerWallet) {
        refundedAmount = transaction.lockedAmount;
        buyerWallet.balance += transaction.lockedAmount;
        buyerWallet.transactions.push({
          type: "deposit",
          amount: transaction.lockedAmount,
          reference: `REFUND-${transaction._id}`,
          status: "completed",
          metadata: {
            purpose: "Transaction cancellation refund",
            transactionId: transaction._id,
          },
          createdAt: new Date(),
        });
        await buyerWallet.save({ session });

        const refundNotification = new Notification({
          userId: buyerWallet.userId.toString(),
          title: "Transaction Refund",
          message: `Transaction ${transaction._id} was cancelled, and ₦${transaction.lockedAmount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} has been refunded to your wallet.`,
          transactionId: transaction._id.toString(),
          type: "transaction",
          status: "completed",
        });
        await refundNotification.save({ session });

        const io = req.app.get("io");
        io.to(buyerWallet.userId.toString()).emit("balanceUpdate", {
          balance: buyerWallet.balance,
          transaction: {
            amount: transaction.lockedAmount,
            reference: `REFUND-${transaction._id}`,
          },
        });
      }
    }

    transaction.status = "cancelled";
    transaction.locked = false;
    transaction.lockedAmount = 0;
    await transaction.save({ session });

    const io = req.app.get("io");
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        status: "cancelled",
        message: "Transaction has been cancelled.",
      });
    });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "Transaction cancelled successfully",
      refunded: refundedAmount
    });
  } catch (error) {
    console.error("Error cancelling transaction:", error);
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.joinTransaction = async (req, res) => {
  try {
    const { id } = req.body;
    const userId = req.user.id;
    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }
    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ success: false, error: "You cannot join your own transaction" });
    }
    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ success: false, error: "You are already a participant" });
    }
    if (transaction.status !== "pending") {
      return res.status(400).json({ success: false, error: "Only pending transactions can be joined" });
    }
    if (transaction.participants.length >= 1) {
      return res.status(400).json({ success: false, error: "Transaction already has a participant" });
    }
    const user = await User.findById(userId);
    if (!user || !user.email || !user.firstName) {
      return res.status(400).json({ success: false, error: "User profile incomplete (missing email or firstName)" });
    }

    // Assign wallet based on role
    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: "NGN",
        transactions: [],
      });
      await wallet.save();
    }

    // Set wallet ID for the participant (opposite role)
    if (transaction.selectedUserType === "buyer") {
      transaction.sellerWalletId = wallet._id;
    } else {
      transaction.buyerWalletId = wallet._id;
    }

    transaction.participants.push(userId);
    await transaction.save();

    // Notify creator
    const notification = new Notification({
      userId: transaction.userId.toString(),
      title: "User Joined Transaction",
      message: `${user.firstName} has joined your transaction ${transaction._id} as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"
        }.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "pending",
    });
    await notification.save();
    const io = req.app.get("io");
    io.to(transaction.userId.toString()).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: `${user.firstName} has joined your transaction as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"
        }.`,
    });

    return res.status(200).json({
      success: true,
      data: {
        message: "Joined transaction successfully",
        role: transaction.selectedUserType === "buyer" ? "seller" : "buyer",
      },
    });
  } catch (error) {
    console.error("Error joining transaction:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.acceptAndUpdateTransaction = async (req, res) => {
  try {
    const { id, description, price } = req.body;
    const userId = req.user.id;

    if (!description || !price || parseFloat(price) <= 0) {
      return res.status(400).json({ success: false, error: "Description and a positive price are required" });
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ success: false, error: "You cannot join your own transaction" });
    }

    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ success: false, error: "You are already a participant" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ success: false, error: "Only pending transactions can be joined" });
    }

    let wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: "NGN",
        transactions: [],
      });
      await wallet.save();
    }

    // Assign wallet based on role
    if (transaction.selectedUserType === "buyer") {
      transaction.sellerWalletId = wallet._id;
    } else {
      transaction.buyerWalletId = wallet._id;
    }

    transaction.productDetails.description = description;
    transaction.productDetails.amount = parseFloat(price);
    transaction.paymentAmount = parseFloat(price);
    transaction.participants.push(userId);
    await transaction.save();

    const creatorId = transaction.userId.toString();
    const notification = new Notification({
      userId: creatorId,
      title: "User Joined and Updated Transaction",
      message: `A user has joined your transaction ${transaction._id} as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"
        } and updated the details.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "accepted",
    });
    await notification.save();

    const io = req.app.get("io");
    io.to(creatorId).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: `A user has joined and updated your transaction as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"
        }.`,
    });

    return res.status(200).json({
      success: true,
      data: {
        message: "Joined transaction successfully",
        role: transaction.selectedUserType === "buyer" ? "seller" : "buyer",
      },
    });
  } catch (error) {
    console.error("Error accepting and updating transaction:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.rejectTransaction = async (req, res) => {
  try {
    const { id } = req.body; // Changed transactionId to id
    const userId = req.user.id;

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ success: false, error: "You cannot reject your own transaction" });
    }

    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ success: false, error: "You are already a participant" });
    }

    const recentNotification = await Notification.findOne({
      userId: transaction.userId.toString(),
      transactionId: id,
      type: "transaction",
      status: "declined",
      createdAt: { $gte: new Date(Date.now() - 3600000) },
    });
    if (recentNotification) {
      return res.status(429).json({ success: false, error: "You have already rejected this transaction recently" });
    }

    const creatorId = transaction.userId.toString();
    const notification = new Notification({
      userId: creatorId,
      title: "User Rejected Transaction",
      message: `A user has rejected your transaction ${transaction._id}.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "declined",
    });
    await notification.save();

    const io = req.app.get("io");
    io.to(creatorId).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: "A user has rejected your transaction.",
    });

    return res.status(200).json({ success: true, message: "Transaction rejected" });
  } catch (error) {
    console.error("Error rejecting transaction:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.updatePaymentStatus = async (req, res) => {
  try {
    const { transactionId, status } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    if (!isCreator) {
      return res.status(403).json({ message: "Only the transaction creator can update payment status" });
    }

    transaction.paymentStatus = status;
    await transaction.save();

    return res.status(200).json({ message: "Payment status updated successfully" });
  } catch (error) {
    console.error("Error updating payment status:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.createChatRoom = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;
    console.log('Creating chatroom for transaction:', { transactionId, userId });

    // Validate transaction
    const transaction = await Transaction.findById(transactionId)
      .populate("userId", "firstName lastName email avatarImage")
      .populate("participants", "firstName lastName email avatarImage");

    if (!transaction) {
      console.warn('Transaction not found:', transactionId);
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    // Check user authorization
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    if (!isCreator && !isParticipant) {
      console.warn('Unauthorized to create chatroom:', { userId, transactionId });
      return res.status(403).json({ success: false, error: "Unauthorized to create chatroom for this transaction" });
    }

    // Check for existing chatroom by transactionId
    const existingChatroom = await Chatroom.findOne({ transactionId });
    if (existingChatroom) {
      console.log('Chatroom already exists for transaction:', { transactionId, chatroomId: existingChatroom._id });
      // Ensure transaction has the correct chatroomId
      if (!transaction.chatroomId || transaction.chatroomId.toString() !== existingChatroom._id.toString()) {
        transaction.chatroomId = existingChatroom._id;
        await transaction.save();
        console.log('Transaction updated with existing chatroomId:', transaction._id);
      }
      return res.status(200).json({ success: true, chatroomId: existingChatroom._id });
    }

    // Create new chatroom
    const chatroom = new Chatroom({
      transactionId,
      participants: [transaction.userId._id, ...transaction.participants.map(p => p._id)],
    });
    await chatroom.save();
    console.log('Chatroom created:', chatroom._id);

    // Update transaction with chatroomId
    transaction.chatroomId = chatroom._id;
    await transaction.save();
    console.log('Transaction updated with chatroomId:', transaction._id);

    // Emit socket event
    const io = req.app.get("io");
    io.to(`transaction_${transactionId}`).emit("transactionUpdated", {
      transactionId,
      message: "Chatroom created for the transaction",
      chatroomId: chatroom._id,
    });

    return res.status(201).json({ success: true, chatroomId: chatroom._id });
  } catch (error) {
    console.error("Error creating chatroom:", {
      transactionId: req.body.transactionId,
      userId,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: "Internal server error", details: error.message });
  }
};

exports.getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(id)
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    const canPreview = transaction.status === "pending" && transaction.participants.length === 0;

    if (!isCreator && !isParticipant && !canPreview) {
      return res.status(403).json({ success: false, error: "Unauthorized to view this transaction" });
    }

    if (!isCreator && !isParticipant && canPreview) {
      const limitedTransaction = {
        _id: transaction._id,
        userId: {
          firstName: transaction.userId.firstName,
          lastName: transaction.userId.lastName,
          email: transaction.userId.email,
        },
        productDetails: {
          description: transaction.productDetails.description,
        },
        paymentAmount: transaction.paymentAmount,
        status: transaction.status,
        selectedUserType: transaction.selectedUserType,
      };
      return res.status(200).json({ success: true, data: limitedTransaction });
    }

    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    console.error("Error fetching transaction by ID:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};


// Submit Waybill Details
exports.submitWaybillDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { transactionId, item, price, shippingAddress, trackingNumber, deliveryDate } = req.body;

    // Validate required fields
    if (!transactionId || !item || !price || !shippingAddress || !trackingNumber || !deliveryDate || !req.file) {
      return res.status(400).json({ error: "All fields and image are required" });
    }

    // Find the transaction
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if user is the seller
    const isSeller = transaction.selectedUserType === "buyer" ? transaction.participants.some(p => p.toString() === userId) : transaction.userId.toString() === userId;
    if (!isSeller) {
      return res.status(403).json({ error: "Only the seller can submit waybill details" });
    }

    // Validate price
    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    // Validate delivery date
    const parsedDate = new Date(deliveryDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: "Invalid delivery date" });
    }

    // Store file path
    const imagePath = `Uploads/${req.file.filename}`;

    // Update transaction with waybill details
    transaction.waybillDetails = {
      item,
      image: imagePath,
      price: parsedPrice,
      shippingAddress,
      trackingNumber,
      deliveryDate: parsedDate,
    };
    transaction.proofOfWaybill = "confirmed";

    await transaction.save();

    // Emit socket event
    const io = req.app.get("io");
    io.to(`transaction_${transactionId}`).emit("transactionUpdated", {
      transactionId,
      message: "Waybill details submitted",
    });

    return res.status(200).json({
      success: true,
      message: "Waybill details submitted successfully",
      data: transaction.waybillDetails,
    });
  } catch (error) {
    console.error("Submit waybill error:", error);
    return res.status(500).json({ error: "Failed to submit waybill details" });
  }
};

// Get Waybill Details
exports.getWaybillDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { transactionId } = req.params;

    // Find the transaction
    const transaction = await Transaction.findById(transactionId).populate("userId participants");
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if user is part of the transaction
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p => p._id.toString() === userId);
    if (!isCreator && !isParticipant) {
      return res.status(403).json({ error: "Unauthorized to view waybill details" });
    }

    if (!transaction.waybillDetails) {
      return res.status(404).json({ error: "No waybill details found for this transaction" });
    }

    return res.status(200).json({
      success: true,
      data: {
        item: transaction.waybillDetails.item,
        image: transaction.waybillDetails.image,
        price: transaction.waybillDetails.price,
        shippingAddress: transaction.waybillDetails.shippingAddress,
        trackingNumber: transaction.waybillDetails.trackingNumber,
        deliveryDate: transaction.waybillDetails.deliveryDate,
      },
    });
  } catch (error) {
    console.error("Get waybill details error:", error);
    return res.status(500).json({ error: "Failed to retrieve waybill details" });
  }
};

exports.getTransactionByChatroomId = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    const userId = req.user.id;

    const chatroom = await Chatroom.findById(chatroomId);
    if (!chatroom) {
      return res.status(404).json({ success: false, error: "Chatroom not found" });
    }

    const transaction = await Transaction.findById(chatroom.transactionId)
      .populate("userId", "firstName lastName email avatarSeed")
      .populate("participants", "firstName lastName email avatarSeed");

    if (!transaction) {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      return res.status(403).json({ success: false, error: "Unauthorized to view this transaction" });
    }

    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    console.error("Error fetching transaction by chatroom ID:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.fundTransactionWithWallet = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { transactionId, amount } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);
    if (!isCreator && !isParticipant) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'Unauthorized to fund this transaction' });
    }

    const isBuyer = (isCreator && transaction.selectedUserType === 'buyer') ||
      (isParticipant && transaction.selectedUserType === 'seller');
    if (!isBuyer) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'Only the buyer can fund the transaction' });
    }

    if (transaction.locked) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Transaction is already funded' });
    }

    if (transaction.status !== 'pending') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Only pending transactions can be funded' });
    }

    if (parseFloat(amount) !== parseFloat(transaction.paymentAmount)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Funding amount must match transaction amount' });
    }

    let buyerWallet = await Wallet.findOne({ userId }).session(session);
    if (!buyerWallet) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Buyer wallet not found' });
    }

    if (buyerWallet.balance < amount) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: 'Insufficient funds in wallet',
        shortfall: amount - buyerWallet.balance,
        balance: buyerWallet.balance
      });
    }

    buyerWallet.transactions.push({
      type: 'withdrawal',
      amount,
      reference: `FUND-${transaction._id}-${uuidv4().slice(0, 8)}`,
      status: 'completed',
      metadata: {
        purpose: 'Transaction funding',
        transactionId: transaction._id,
      },
      createdAt: new Date(),
    });

    await buyerWallet.recalculateBalance();
    await buyerWallet.save({ session });

    transaction.locked = true;
    transaction.lockedAmount = amount;
    transaction.buyerWalletId = buyerWallet._id;
    transaction.funded = true;
    await transaction.save({ session });

    const io = req.app.get('io');
    io.to(userId).emit('balanceUpdate', {
      balance: buyerWallet.balance,
      transaction: {
        amount,
        reference: `FUND-${transaction._id}`,
      },
    });

    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit('transactionUpdated', {
        transactionId: transaction._id,
        message: 'Transaction has been funded.',
      });
    });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({ message: 'Transaction funded successfully' });
  } catch (error) {
    console.error('Error funding transaction:', error);
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

// New Paystack callback handler
exports.handlePaystackCallback = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { reference, transactionId } = req.query;
    const userId = req.user.id;

    if (!reference || !transactionId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Reference and transaction ID required' });
    }

    const paystackResponse = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    if (!paystackResponse.data.status || paystackResponse.data.data.status !== 'success') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    const amount = paystackResponse.data.data.amount / 100; // Paystack returns amount in kobo
    const wallet = await Wallet.findOne({ userId }).session(session);
    if (!wallet) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Wallet not found' });
    }

    wallet.transactions.push({
      type: 'deposit',
      amount,
      reference: `PAYSTACK-${reference}`,
      paystackReference: reference,
      status: 'completed',
      metadata: {
        purpose: 'Transaction funding top-up',
        transactionId,
      },
      createdAt: new Date(),
    });

    await wallet.recalculateBalance();
    await wallet.save({ session });

    const transaction = await Transaction.findById(transactionId).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Transaction not found' });
    }

    if (wallet.balance >= transaction.paymentAmount) {
      await exports.fundTransactionWithWallet({
        body: { transactionId, amount: transaction.paymentAmount },
        user: { id: userId },
        app: req.app,
      }, null, session); // Pass session to fundTransactionWithWallet
    } else {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: 'Insufficient wallet balance after funding',
        balance: wallet.balance,
        required: transaction.paymentAmount,
      });
    }

    const io = req.app.get('io');
    io.to(userId).emit('balanceUpdate', {
      balance: wallet.balance,
      transaction: { amount, reference },
    });

    await session.commitTransaction();
    session.endSession();
    res.redirect(`/transactions?success=true&transactionId=${transactionId}`);
  } catch (error) {
    console.error('Error handling Paystack callback:', error);
    await session.abortTransaction();
    session.endSession();
    res.redirect(`/transactions?success=false&error=${encodeURIComponent(error.message)}`);
  }
};

// Update wallet funding to include transactionId in metadata
exports.fundWallet = async (req, res) => {
  try {
    const { amount, email, phoneNumber, transactionId } = req.body;
    const userId = req.user.id;

    const wallet = await Wallet.findOne({ userId });
    if (!wallet) {
      return res.status(404).json({ message: 'Wallet not found' });
    }

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        amount: Math.ceil(amount * 100), // Convert to kobo
        email,
        reference: `FUND-${uuidv4()}`,
        metadata: { userId, transactionId },
        callback_url: `${req.protocol}://${req.get('host')}/api/wallet/paystack-callback?transactionId=${transactionId}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.status && response.data.data.authorization_url) {
      return res.status(200).json({
        success: true,
        data: {
          authorization_url: response.data.data.authorization_url,
          reference: response.data.data.reference,
        },
      });
    } else {
      throw new Error('Failed to initialize Paystack transaction');
    }
  } catch (error) {
    console.error('Error funding wallet:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

exports.updatePaymentDetails = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { paymentAmount } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    console.log('User ID from token:', userId);
    console.log('Transaction User ID:', transaction.userId.toString());
    const isCreator = transaction.userId.toString() === userId;
    if (!isCreator) {
      console.log('Authorization failed: User is not the transaction creator');
      return res.status(403).json({ message: "Only the transaction creator can update payment details" });
    }

    if (transaction.locked) {
      return res.status(400).json({ message: "Cannot update payment details for a funded transaction" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be updated" });
    }

    if (!paymentAmount || isNaN(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    transaction.paymentAmount = parseFloat(paymentAmount);
    transaction.productDetails.amount = parseFloat(paymentAmount);
    await transaction.save();

    const io = req.app.get("io");
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        message: `Payment amount updated to ₦${parseFloat(paymentAmount).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`,
      });
    });

    return res.status(200).json({ message: "Payment details updated successfully", transaction });
  } catch (error) {
    console.error("Error updating payment details:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.confirmTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;

    console.log('Confirm transaction request:', { transactionId, userId });

    const transaction = await Transaction.findById(transactionId)
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email")
      .session(session);
    if (!transaction) {
      console.log('Transaction not found:', transactionId);
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    if (!isCreator && !isParticipant) {
      console.log('Unauthorized access:', { userId, transactionId });
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Unauthorized to confirm this transaction" });
    }

    const isBuyer = (isCreator && transaction.selectedUserType === "buyer") ||
      (isParticipant && transaction.selectedUserType === "seller");
    console.log('User role:', { isBuyer, isCreator, isParticipant, selectedUserType: transaction.selectedUserType });

    if (transaction.status !== "pending") {
      console.log('Invalid transaction status:', transaction.status);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Only pending transactions can be confirmed" });
    }

    if (!transaction.locked || !transaction.funded) {
      console.log('Transaction not funded:', { locked: transaction.locked, funded: transaction.funded });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Transaction must be funded before confirmation" });
    }

    // Check buyer's wallet balance before allowing confirmation
    if (isBuyer) {
      const buyerWallet = await Wallet.findOne({ userId }).session(session);
      if (!buyerWallet) {
        console.log('Buyer wallet not found:', { userId });
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: "Buyer wallet not found" });
      }
      if (buyerWallet.balance < transaction.paymentAmount) {
        console.log('Insufficient buyer wallet balance:', {
          balance: buyerWallet.balance,
          required: transaction.paymentAmount,
        });
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          message: "Insufficient funds in wallet to confirm transaction",
          shortfall: transaction.paymentAmount - buyerWallet.balance,
          balance: buyerWallet.balance,
        });
      }
    }

    if (isBuyer) {
      if (transaction.buyerConfirmed) {
        console.log('Buyer already confirmed:', transactionId);
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Buyer has already confirmed this transaction" });
      }
      transaction.buyerConfirmed = true;
    } else {
      if (transaction.sellerConfirmed) {
        console.log('Seller already confirmed:', transactionId);
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Seller has already confirmed this transaction" });
      }
      transaction.sellerConfirmed = true;
    }

    let notificationMessage = "";
    let notificationTitle = "";
    const otherPartyId = isCreator
      ? transaction.participants[0]?._id?.toString()
      : transaction.userId._id.toString();

    if (transaction.buyerConfirmed && transaction.sellerConfirmed) {
      transaction.status = "completed";
      transaction.payoutReleased = true;

      const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
      const sellerWallet = await Wallet.findById(transaction.sellerWalletId).session(session);
      if (!buyerWallet || !sellerWallet) {
        console.log('Wallets not found:', {
          buyerWalletId: transaction.buyerWalletId,
          sellerWalletId: transaction.sellerWalletId,
        });
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Buyer or seller wallet not found" });
      }

      // Transfer funds to seller
      const payoutAmount = transaction.lockedAmount; // Store before resetting
      sellerWallet.balance += payoutAmount;
      sellerWallet.transactions.push({
        type: "deposit",
        amount: payoutAmount,
        reference: `PAYOUT-${transaction._id}`,
        status: "completed",
        metadata: {
          purpose: "Transaction payout",
          transactionId: transaction._id,
        },
        createdAt: new Date(),
      });

      await sellerWallet.save({ session });
      console.log('Funds transferred to seller wallet:', {
        sellerWalletId: sellerWallet._id,
        amount: payoutAmount,
        newBalance: sellerWallet.balance,
      });

      // Reset locked state after payout
      transaction.locked = false;
      transaction.lockedAmount = 0;

      const io = req.app.get("io");
      io.to(sellerWallet.userId.toString()).emit("balanceUpdate", {
        balance: sellerWallet.balance,
        transaction: {
          amount: payoutAmount,
          reference: `PAYOUT-${transaction._id}`,
        },
      });

      notificationTitle = "Transaction Completed";
      notificationMessage = `Transaction ${transaction._id} has been completed. Funds have been released to the seller.`;
    } else {
      notificationTitle = "Transaction Confirmation Pending";
      notificationMessage = `Waiting for the other party to confirm transaction ${transaction._id}.`;
    }

    await transaction.save({ session });
    console.log('Transaction updated:', {
      transactionId: transaction._id,
      status: transaction.status,
      buyerConfirmed: transaction.buyerConfirmed,
      sellerConfirmed: transaction.sellerConfirmed,
      locked: transaction.locked,
      lockedAmount: transaction.lockedAmount,
    });

    if (otherPartyId) {
      const notification = new Notification({
        userId: otherPartyId,
        title: notificationTitle,
        message: notificationMessage,
        transactionId: transaction._id.toString(),
        type: "confirmation",
        status: transaction.status,
      });

      await notification.save({ session });
      console.log('Notification created:', {
        notificationId: notification._id,
        userId: otherPartyId,
        title: notificationTitle,
        message: notificationMessage,
      });

      const io = req.app.get("io");
      io.to(otherPartyId).emit("transactionUpdated", {
        transactionId: transaction._id,
        message: notificationMessage,
        status: transaction.status,
      });
    }

    if (transaction.status === "completed") {
      const usersToNotify = [
        transaction.userId._id.toString(),
        ...transaction.participants.map((p) => p._id.toString()),
      ];
      const notificationPromises = usersToNotify.map((notifyUserId) =>
        Notification.create({
          userId: notifyUserId,
          title: "Transaction Completed",
          message: `Transaction ${transaction._id} has been completed. Funds have been released to the seller.`,
          transactionId: transaction._id.toString(),
          type: "confirmation",
          status: "completed",
        }, { session })
      );

      await Promise.all(notificationPromises);
      console.log('Completion notifications sent to all parties:', usersToNotify);

      const io = req.app.get("io");
      usersToNotify.forEach((userId) => {
        io.to(userId).emit("transactionCompleted", {
          transactionId: transaction._id,
          message: `Transaction ${transaction._id} has been completed.`,
        });
      });
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: transaction.status === "completed"
        ? "Transaction completed successfully"
        : "Confirmation recorded, waiting for other party",
      transaction,
    });
  } catch (error) {
    console.error("Error in confirmTransaction:", error);
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};




module.exports = exports;