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
const fsPromises = require("fs").promises; // For promise-based methods
const fs = require("fs"); // For synchronous methods
const axios = require("axios");

// Ensure the Uploads directory exists
const uploadDir = path.join(__dirname, "../Uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('Created Uploads directory at:', uploadDir);
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

exports.getUserTransactions = async (req, res) => {
  try {
    const userId = req.user.id;

    console.log("Fetching transactions for user:", userId);

    const transactions = await Transaction.find({
      $or: [
        { userId },
        { 'participants.userId': userId },
      ],
    })
      .populate("userId", "firstName lastName email avatarImage")
      .populate("participants.userId", "firstName lastName email avatarImage")
      .lean();

    const cleanedTransactions = transactions
      .filter(t => {
        if (!t || !t._id) {
          console.warn("Invalid transaction filtered out:", t);
          return false;
        }
        return true;
      })
      .map(t => {
        const isCreator = t.userId?._id?.toString() === userId;
        const isParticipant = t.participants.some(p => p.userId && p.userId._id?.toString() === userId);
        const userRole = isCreator
          ? t.selectedUserType
          : t.selectedUserType === "buyer"
            ? "seller"
            : "buyer";

        t.participants = t.participants.filter(p => {
          if (!p.userId || !p.userId._id) {
            console.warn("Invalid participant filtered out:", p);
            return false;
          }
          return true;
        });

        return {
          ...t,
          userRole,
        };
      });

    if (cleanedTransactions.length === 0 && transactions.length > 0) {
      console.warn("All transactions were invalid for user:", userId);
    }

    console.log("Transactions fetched:", cleanedTransactions.length);
    return res.status(200).json({
      success: true,
      data: cleanedTransactions,
    });
  } catch (error) {
    console.error("Error fetching transactions:", {
      message: error.message,
      stack: error.stack,
      userId: req.user.id,
    });
    return res.status(500).json({
      success: false,
      error: "Failed to fetch transactions. Please try again later.",
      details: error.message,
    });
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

    console.log('Fetching transaction:', { transactionId: id, userId });

    const transaction = await Transaction.findById(id)
      .populate("userId", "firstName lastName email avatarImage")
      .populate("participants.userId", "firstName lastName email avatarImage");

    if (!transaction) {
      console.log('Transaction not found:', id);
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    transaction.participants = transaction.participants.filter(
      (p) => p.userId && mongoose.Types.ObjectId.isValid(p.userId)
    );
    await transaction.save();

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p.userId && p.userId._id.toString() === userId
    );
    const canPreview = transaction.status === "pending" && transaction.participants.length === 0;

    console.log('Authorization check:', {
      isCreator,
      isParticipant,
      canPreview,
      transactionStatus: transaction.status,
      participantsCount: transaction.participants.length,
      creatorId: transaction.userId._id.toString(),
      participantIds: transaction.participants.map(p => p.userId?._id.toString()),
    });

    if (!isCreator && !isParticipant && !canPreview) {
      return res.status(403).json({
        success: false,
        error: `Unauthorized to view this transaction. Status: ${transaction.status}, Participants: ${transaction.participants.length}`,
      });
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
      console.log('Returning limited transaction data for preview');
      return res.status(200).json({ success: true, data: limitedTransaction });
    }

    console.log('Returning full transaction data');
    return res.status(200).json({ success: true, data: transaction });
  } catch (error) {
    console.error("Error fetching transaction by ID:", error.message, error.stack);
    return res.status(500).json({ success: false, error: "Internal server error", details: error.message });
  }
};

// exports.cancelTransaction = async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const { id } = req.params;
//     const userId = req.user.id;

//     // Validate transaction ID
//     if (!mongoose.Types.ObjectId.isValid(id)) {
//       await session.abortTransaction();
//       session.endSession();
//       console.warn('Invalid transaction ID:', id);
//       return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
//     }

//     const transaction = await Transaction.findById(id).session(session);

//     if (!transaction) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: "Transaction not found" });
//     }

//     const isCreator = transaction.userId.toString() === userId;
//     const isParticipant = transaction.participants.some(
//       (p) => p.userId.toString() === userId
//     );

//     if (!isCreator && !isParticipant) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(403).json({ message: "Unauthorized to cancel this transaction" });
//     }

//     if (transaction.status !== "pending" && transaction.status !== "funded") {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: "Only pending or funded transactions can be cancelled" });
//     }

//     // Initialize cancelConfirmations if not present
//     if (!transaction.cancelConfirmations) {
//       transaction.cancelConfirmations = { creator: false, participant: false };
//     }

//     const userRole = isCreator ? "creator" : "participant";
//     transaction.cancelConfirmations[userRole] = true;

//     let responseMessage = "";
//     let refundedAmount = 0;

//     // For non-funded (pending) transactions, cancel immediately
//     if (transaction.status === "pending" && !transaction.locked) {
//       transaction.status = "canceled";
//       responseMessage = "Transaction cancelled successfully";
//     } else if (transaction.status === "funded" && transaction.locked) {
//       // For funded transactions, require both confirmations
//       if (transaction.cancelConfirmations.creator && transaction.cancelConfirmations.participant) {
//         transaction.status = "canceled";
//         responseMessage = "Transaction cancelled successfully with both confirmations";

//         // Handle refund if transaction is funded
//         if (transaction.buyerWalletId && transaction.lockedAmount > 0) {
//           const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
//           if (buyerWallet) {
//             refundedAmount = transaction.lockedAmount;
//             buyerWallet.balance += transaction.lockedAmount;
//             buyerWallet.transactions.push({
//               type: "deposit",
//               amount: transaction.lockedAmount,
//               reference: `REFUND-${transaction._id}`,
//               status: "completed",
//               metadata: {
//                 purpose: "Transaction cancellation refund",
//                 transactionId: transaction._id,
//               },
//               createdAt: new Date(),
//             });
//             await buyerWallet.save({ session });

//             const refundNotification = new Notification({
//               userId: buyerWallet.userId.toString(),
//               title: "Transaction Refund",
//               message: `Transaction ${transaction._id} was cancelled, and ₦${transaction.lockedAmount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} has been refunded to your wallet.`,
//               transactionId: transaction._id.toString(),
//               type: "transaction",
//               status: "completed",
//             });
//             await refundNotification.save({ session });

//             const io = req.app.get("io");
//             io.to(buyerWallet.userId.toString()).emit("balanceUpdate", {
//               balance: buyerWallet.balance,
//               transaction: {
//                 amount: transaction.lockedAmount,
//                 reference: `REFUND-${transaction._id}`,
//               },
//             });
//           }
//         }
//         transaction.locked = false;
//         transaction.lockedAmount = 0;
//       } else {
//         // Only one party has confirmed cancellation
//         responseMessage = `Cancellation request recorded. Waiting for ${isCreator ? "participant" : "creator"} confirmation.`;
//         await transaction.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         const io = req.app.get("io");
//         const usersToNotify = [
//           transaction.userId.toString(),
//           ...transaction.participants.map((p) => p.userId.toString()),
//         ];
//         usersToNotify.forEach((userId) => {
//           io.to(userId).emit("transactionUpdated", {
//             transactionId: transaction._id,
//             status: transaction.status,
//             message: responseMessage,
//             cancelConfirmations: transaction.cancelConfirmations,
//           });
//         });

//         return res.status(200).json({
//           message: responseMessage,
//           refunded: 0,
//           transaction: transaction.toObject(),
//         });
//       }
//     }

//     await transaction.save({ session });

//     const io = req.app.get("io");
//     const usersToNotify = [
//       transaction.userId.toString(),
//       ...transaction.participants.map((p) => p.userId.toString()),
//     ];
//     usersToNotify.forEach((userId) => {
//       io.to(userId).emit("transactionUpdated", {
//         transactionId: transaction._id,
//         status: transaction.status,
//         message: responseMessage,
//       });
//     });

//     await session.commitTransaction();
//     session.endSession();

//     return res.status(200).json({
//       message: responseMessage,
//       refunded: refundedAmount,
//       transaction: transaction.toObject(),
//     });
//   } catch (error) {
//     console.error("Error cancelling transaction:", error);
//     await session.abortTransaction();
//     session.endSession();
//     return res.status(500).json({ message: "Internal server error: " + error.message });
//   }
// };


// Updated cancelTransaction controller (minor fixes for consistency)
exports.cancelTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(id)) {
      await session.abortTransaction();
      session.endSession();
      console.warn('Invalid transaction ID:', id);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

    const transaction = await Transaction.findById(id).session(session);

    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p.userId.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Unauthorized to cancel this transaction" });
    }

    if (transaction.status !== "pending" && transaction.status !== "funded") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Only pending or funded transactions can be cancelled" });
    }

    // Initialize cancelConfirmations if not present
    if (!transaction.cancelConfirmations) {
      transaction.cancelConfirmations = { creator: false, participant: false };
    }

    const userRole = isCreator ? "creator" : "participant";
    transaction.cancelConfirmations[userRole] = true;

    let responseMessage = "";
    let refundedAmount = 0;

    // For non-funded (pending) transactions, cancel immediately
    if (transaction.status === "pending" && !transaction.locked) {
      transaction.status = "canceled";
      responseMessage = "Transaction cancelled successfully";
    } else if (transaction.status === "funded" && transaction.locked) {
      // For funded transactions, require both confirmations
      if (transaction.cancelConfirmations.creator && transaction.cancelConfirmations.participant) {
        transaction.status = "canceled";
        responseMessage = "Transaction cancelled successfully with both confirmations";

        // Handle refund if transaction is funded
        if (transaction.buyerWalletId && transaction.lockedAmount > 0) {
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
        transaction.locked = false;
        transaction.lockedAmount = 0;
      } else {
        // Only one party has confirmed cancellation
        responseMessage = `Cancellation request recorded. Waiting for ${isCreator ? "participant" : "creator"} confirmation.`;
        await transaction.save({ session });
        await session.commitTransaction();
        session.endSession();

        const io = req.app.get("io");
        const usersToNotify = [
          transaction.userId.toString(),
          ...transaction.participants.map((p) => p.userId.toString()),
        ];
        usersToNotify.forEach((userId) => {
          io.to(userId).emit("transactionUpdated", {
            transactionId: transaction._id,
            status: transaction.status,
            message: responseMessage,
            cancelConfirmations: transaction.cancelConfirmations,
          });
        });

        return res.status(200).json({
          message: responseMessage,
          refunded: 0,
          transaction: transaction.toObject(),
        });
      }
    }

    await transaction.save({ session });

    const io = req.app.get("io");
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.userId.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        status: transaction.status,
        message: responseMessage,
      });
    });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: responseMessage,
      refunded: refundedAmount,
      transaction: transaction.toObject(),
    });
  } catch (error) {
    console.error("Error cancelling transaction:", error);
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: "Internal server error: " + error.message });
  }
};



exports.joinTransaction = async (req, res) => {
  try {
    // Destructure and validate request body
    const { id } = req.body;
    const userId = req.user?.id;

    // Validate request body structure
    if (!req.body || typeof id !== 'string' || !id.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Transaction ID is required and must be a non-empty string',
      });
    }

    // Validate userId from authentication middleware
    if (!userId || typeof userId !== 'string' || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or missing user authentication',
      });
    }

    // Validate transaction ID format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid transaction ID format',
      });
    }

    // Fetch transaction with necessary fields
    const transaction = await Transaction.findById(id).select(
      'userId participants status selectedUserType buyerWalletId sellerWalletId'
    );
    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found',
      });
    }

    // Prevent creator from joining their own transaction
    if (transaction.userId.toString() === userId) {
      return res.status(400).json({
        success: false,
        error: 'You cannot join your own transaction',
      });
    }

    // Check if user is already a participant
    if (transaction.participants.some((p) => p.userId && p.userId.toString() === userId)) {
      return res.status(400).json({
        success: false,
        error: 'You are already a participant in this transaction',
      });
    }

    // Ensure transaction is pending
    if (transaction.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Only pending transactions can be joined',
      });
    }

    // Limit to one participant
    if (transaction.participants.length >= 1) {
      return res.status(400).json({
        success: false,
        error: 'Transaction already has a participant',
      });
    }

    // Verify user profile completeness
    const user = await User.findById(userId).select('email firstName');
    if (!user || !user.email || !user.firstName) {
      return res.status(400).json({
        success: false,
        error: 'User profile incomplete (missing email or firstName)',
      });
    }

    // Ensure user has a wallet
    let wallet = await Wallet.findOne({ userId }).select('_id');
    if (!wallet) {
      wallet = new Wallet({
        userId,
        balance: 0,
        totalDeposits: 0,
        currency: 'NGN',
        transactions: [],
      });
      await wallet.save();
    }

    // Determine participant role
    const participantRole = transaction.selectedUserType === 'buyer' ? 'seller' : 'buyer';

    // Assign wallet ID based on role
    if (participantRole === 'seller') {
      transaction.sellerWalletId = wallet._id;
    } else {
      transaction.buyerWalletId = wallet._id;
    }

    // Add participant to transaction
    transaction.participants.push({ userId, role: participantRole });
    await transaction.save();

    // Create notification for transaction creator
    const notification = new Notification({
      userId: transaction.userId.toString(),
      title: 'User Joined Transaction',
      message: `${user.firstName} has joined your transaction ${transaction._id} as ${participantRole}.`,
      transactionId: transaction._id.toString(),
      type: 'transaction',
      status: 'pending',
    });
    await notification.save();

    // Emit WebSocket event
    const io = req.app.get('io');
    if (io) {
      io.to(transaction.userId.toString()).emit('transactionUpdated', {
        transactionId: transaction._id,
        message: `${user.firstName} has joined your transaction as ${participantRole}.`,
      });
    } else {
      console.warn('Socket.io instance not found');
    }

    // Log successful join for debugging
    console.log(`User ${userId} joined transaction ${id} as ${participantRole}`);

    return res.status(200).json({
      success: true,
      data: {
        message: 'Joined transaction successfully',
        role: participantRole,
      },
    });
  } catch (error) {
    // Enhanced error logging
    console.error('Error joining transaction:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
      userId: req.user?.id,
    });

    // Handle specific Mongoose errors
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        details: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
};

exports.acceptAndUpdateTransaction = async (req, res) => {
  try {
    const { id, description, price } = req.body;
    const userId = req.user.id;

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(id)) {
      console.warn('Invalid transaction ID:', id);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

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
      message: `A user has joined your transaction ${transaction._id} as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"} and updated the details.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "accepted",
    });
    await notification.save();

    const io = req.app.get("io");
    io.to(creatorId).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: `A user has joined and updated your transaction as ${transaction.selectedUserType === "buyer" ? "seller" : "buyer"}.`,
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
    const { id } = req.body;
    const userId = req.user.id;

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(id)) {
      console.warn('Invalid transaction ID:', id);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

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

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('Invalid transaction ID:', transactionId);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

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

    // Validate input
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('Invalid transactionId format:', transactionId);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

    // Find transaction with populated userId and participants.userId
    const transaction = await Transaction.findById(transactionId)
      .populate('userId', 'firstName lastName email avatarSeed')
      .populate('participants.userId', 'firstName lastName email avatarSeed');
    if (!transaction) {
      console.warn('Transaction not found:', transactionId);
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // Check user authorization
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p.userId && p.userId._id.toString() === userId
    );
    if (!isCreator && !isParticipant) {
      console.warn('Unauthorized to create chatroom:', { userId, transactionId });
      return res.status(403).json({ success: false, error: 'Unauthorized to create chatroom for this transaction' });
    }

    // Check for existing chatroom by transactionId
    let chatroom = await Chatroom.findOne({ transactionId })
      .populate('participants.userId', 'firstName lastName email avatarSeed');
    if (chatroom) {
      console.log('Chatroom already exists for transaction:', { transactionId, chatroomId: chatroom._id });
      // Ensure transaction has the correct chatroomId
      if (!transaction.chatroomId || transaction.chatroomId.toString() !== chatroom._id.toString()) {
        transaction.chatroomId = chatroom._id;
        await transaction.save();
        console.log('Transaction updated with existing chatroomId:', transaction._id);
      }
      return res.status(200).json({
        success: true,
        chatroomId: chatroom._id,
        participants: chatroom.participants.map(p => ({
          userId: p.userId ? {
            _id: p.userId._id,
            firstName: p.userId.firstName || 'User',
            lastName: p.userId.lastName || '',
            email: p.userId.email || 'N/A',
            avatarSeed: p.userId.avatarSeed || p.userId._id,
          } : null,
          role: p.role,
        })).filter(p => p.userId),
      });
    }

    // Create new chatroom with participants matching Transaction schema
    chatroom = new Chatroom({
      transactionId,
      participants: [
        { userId: transaction.userId._id, role: transaction.selectedUserType },
        ...transaction.participants.map(p => ({
          userId: p.userId._id,
          role: p.role,
        })),
      ],
    });
    await chatroom.save();
    console.log('Chatroom created:', JSON.stringify(chatroom, null, 2));

    // Update transaction with chatroomId
    transaction.chatroomId = chatroom._id;
    await transaction.save();
    console.log('Transaction updated with chatroomId:', transaction._id);

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      io.to(`transaction_${transactionId}`).emit('transactionUpdated', {
        transactionId,
        message: 'Chatroom created for the transaction',
        chatroomId: chatroom._id,
      });
    } else {
      console.warn('Socket.io instance not available');
    }

    // Populate participants for response
    await chatroom.populate('participants.userId', 'firstName lastName email avatarSeed');
    return res.status(201).json({
      success: true,
      chatroomId: chatroom._id,
      participants: chatroom.participants.map(p => ({
        userId: p.userId ? {
          _id: p.userId._id,
          firstName: p.userId.firstName || 'User',
          lastName: p.userId.lastName || '',
          email: p.userId.email || 'N/A',
          avatarSeed: p.userId.avatarSeed || p.userId._id,
        } : null,
        role: p.role,
      })).filter(p => p.userId),
    });
  } catch (error) {
    console.error('Error creating chatroom:', {
      transactionId: req.body.transactionId,
      userId,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
};

async function ensureUploadsDirectory() {
  const uploadsDir = path.join(__dirname, '..', 'Uploads', 'images');
  try {
    await fsPromises.mkdir(uploadsDir, { recursive: true });
    console.log('submitWaybillDetails - Uploads/images directory ensured at:', uploadsDir);
  } catch (error) {
    console.error('submitWaybillDetails - Failed to create Uploads/images directory:', error);
    throw error;
  }
}

async function verifyFileWithRetry(filePath, retries = 3, delay = 100) {
  for (let i = 0; i < retries; i++) {
    try {
      await fsPromises.access(filePath);
      console.log('submitWaybillDetails - Image verified successfully:', filePath);
      return true;
    } catch (error) {
      console.warn(`submitWaybillDetails - Attempt ${i + 1} failed to verify file:`, filePath, error);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error('File verification failed after retries');
}

exports.submitWaybillDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { transactionId, item, shippingAddress, trackingNumber, deliveryDate } = req.body;

    console.log('submitWaybillDetails - Request received:', {
      transactionId,
      userId,
      item,
      shippingAddress,
      trackingNumber,
      deliveryDate,
      hasFile: !!req.file,
      fileDetails: req.file ? { filename: req.file.filename, path: req.file.path } : null
    });

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('Invalid transaction ID:', transactionId);
      return res.status(400).json({ success: false, error: "Invalid transaction ID format" });
    }

    // Validate required fields
    if (!item || !shippingAddress || !trackingNumber || !deliveryDate) {
      console.warn('Missing required fields:', { item, shippingAddress, trackingNumber, deliveryDate });
      return res.status(400).json({ success: false, error: "All fields are required" });
    }

    // Find transaction
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      console.warn('Transaction not found:', transactionId);
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if user is authorized (seller)
    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.some(p => p.userId.toString() === userId && p.role === 'seller');
    if (!isCreator && !isParticipant) {
      console.warn('Unauthorized access:', { userId, transactionId });
      return res.status(403).json({ error: "Unauthorized to submit waybill details" });
    }

    // Check if transaction is funded
    if (!transaction.locked) {
      console.warn('Transaction not funded:', transactionId);
      return res.status(400).json({ error: "Transaction must be funded before submitting waybill details" });
    }

    // Ensure Uploads/images directory exists
    await ensureUploadsDirectory();

    // Handle file upload
    let imagePath = null;
    if (req.file) {
      imagePath = `Uploads/images/${req.file.filename}`;
      const fullPath = path.join(__dirname, '..', imagePath);
      try {
        await verifyFileWithRetry(fullPath);
        console.log('submitWaybillDetails - Image saved successfully:', fullPath);
      } catch (error) {
        console.error('submitWaybillDetails - Failed to verify image file:', fullPath, error);
        return res.status(500).json({ success: false, error: "Failed to save image file" });
      }
    } else {
      console.warn('No image file uploaded:', transactionId);
      return res.status(400).json({ success: false, error: "Image is required" });
    }

    // Update transaction with waybill details
    transaction.waybillDetails = {
      item,
      shippingAddress,
      trackingNumber,
      deliveryDate,
      image: imagePath,
    };

    await transaction.save();
    console.log('submitWaybillDetails - Waybill details saved:', { transactionId, imagePath });

    // Emit socket event
    const io = req.app.get("io");
    io.to(`transaction_${transactionId}`).emit("transactionUpdated", {
      transactionId,
      message: "Waybill details submitted",
    });

    return res.status(200).json({ success: true, message: "Waybill details submitted successfully" });
  } catch (error) {
    console.error("Submit waybill details error:", error);
    const errorMessage = error.code === 'ERR_INVALID_ARG_TYPE'
      ? 'Server configuration error: Unable to create upload directory'
      : 'Failed to submit waybill details';
    return res.status(500).json({ success: false, error: errorMessage });
  }
};

exports.getWaybillDetails = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { transactionId } = req.params;

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('getWaybillDetails - Invalid transaction ID:', transactionId);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

    // Find the transaction
    const transaction = await Transaction.findById(transactionId).populate("userId participants.userId");
    if (!transaction) {
      console.warn('getWaybillDetails - Transaction not found:', transactionId);
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Check if user is part of the transaction
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p => p.userId._id.toString() === userId);
    if (!isCreator && !isParticipant) {
      console.warn('getWaybillDetails - Unauthorized access:', { userId, transactionId });
      return res.status(403).json({ error: "Unauthorized to view waybill details" });
    }

    if (!transaction.waybillDetails) {
      console.log('getWaybillDetails - No waybill details for transaction:', transactionId);
      return res.status(200).json({ success: true, data: {} });
    }

    // Construct absolute URL for the image
    const baseUrl = process.env.VITE_BASE_URL || 'http://localhost:3001';
    let imageUrl = null;
    if (transaction.waybillDetails.image) {
      // Normalize path to use forward slashes
      const normalizedImagePath = transaction.waybillDetails.image.replace(/\\/g, '/');
      imageUrl = `${baseUrl}/${normalizedImagePath}`;
      console.log('getWaybillDetails - Image URL constructed:', imageUrl);

      // Optional: Verify file existence (for debugging, can be removed in production)
      const fullPath = path.join(__dirname, normalizedImagePath);
      try {
        await fs.access(fullPath);
        console.log('getWaybillDetails - Image file verified at:', fullPath);
      } catch (error) {
        console.error('getWaybillDetails - Image file not accessible:', fullPath, error.message);
        // Don't set imageUrl to null; let the frontend attempt to load it
      }
    } else {
      console.log('getWaybillDetails - No image in waybillDetails:', transactionId);
    }

    return res.status(200).json({
      success: true,
      data: {
        item: transaction.waybillDetails.item,
        image: imageUrl,
        shippingAddress: transaction.waybillDetails.shippingAddress,
        trackingNumber: transaction.waybillDetails.trackingNumber,
        deliveryDate: transaction.waybillDetails.deliveryDate,
      },
    });
  } catch (error) {
    console.error("getWaybillDetails - Error:", error.message, error.stack);
    return res.status(500).json({ error: "Failed to retrieve waybill details" });
  }
};

exports.getTransactionByChatroomId = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    const userId = req.user.id;

    // Validate chatroomId
    if (!mongoose.Types.ObjectId.isValid(chatroomId)) {
      console.warn('Invalid chatroomId format:', chatroomId);
      return res.status(400).json({ success: false, error: 'Invalid chatroom ID format' });
    }

    // Find chatroom
    const chatroom = await Chatroom.findById(chatroomId);
    if (!chatroom) {
      console.warn('Chatroom not found:', chatroomId);
      return res.status(404).json({ success: false, error: 'Chatroom not found' });
    }

    // Find transaction and populate userId and participants.userId
    const transaction = await Transaction.findById(chatroom.transactionId)
      .populate('userId', 'firstName lastName email avatarSeed')
      .populate('participants.userId', 'firstName lastName email avatarSeed')
      .lean();

    if (!transaction) {
      console.warn('Transaction not found for chatroom:', { chatroomId, transactionId: chatroom.transactionId });
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // Verify user access
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p.userId && p.userId._id.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      console.warn('Unauthorized access:', { userId, chatroomId, transactionId: transaction._id });
      return res.status(403).json({ success: false, error: 'Unauthorized to view this transaction' });
    }

    // Ensure participants array includes role and populated user details
    const formattedTransaction = {
      ...transaction,
      participants: transaction.participants.map((p) => ({
        userId: p.userId ? {
          _id: p.userId._id,
          firstName: p.userId.firstName || 'User',
          lastName: p.userId.lastName || '',
          email: p.userId.email || 'N/A',
          avatarSeed: p.userId.avatarSeed || p.userId._id,
        } : null,
        role: p.role,
      })).filter(p => p.userId),
    };

    console.log('Transaction data sent:', JSON.stringify(formattedTransaction, null, 2));
    return res.status(200).json({ success: true, data: formattedTransaction });
  } catch (error) {
    console.error('Error fetching transaction by chatroom ID:', {
      chatroomId,
      userId,
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

exports.fundTransactionWithWallet = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { transactionId, amount } = req.body;
    const userId = req.user.id;

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      await session.abortTransaction();
      session.endSession();
      console.warn('Invalid transaction ID:', transactionId);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

    const transaction = await Transaction.findById(transactionId).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const isCreator = transaction.userId.toString() === userId;
    const participant = transaction.participants.find(p => p.userId.toString() === userId);
    const isParticipant = !!participant;
    if (!isCreator && !isParticipant) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'Unauthorized to fund this transaction' });
    }

    const isBuyer = isCreator
      ? transaction.selectedUserType === 'buyer'
      : participant && participant.role === 'buyer';
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
        message: 'Insufficient wallet balance. Please top up your wallet in your Profile to fund this transaction.',
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

    buyerWallet.balance -= parseFloat(amount);
    await buyerWallet.save({ session });

    transaction.locked = true;
    transaction.lockedAmount = amount;
    transaction.buyerWalletId = buyerWallet._id;
    transaction.funded = true;
    transaction.status = 'funded';
    await transaction.save({ session });

    // Create notifications for both parties
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.userId.toString()),
    ];
    const notificationPromises = usersToNotify.map((notifyUserId) => {
      if (!mongoose.Types.ObjectId.isValid(notifyUserId)) {
        console.warn('Invalid userId for notification:', notifyUserId);
        return Promise.resolve();
      }
      return Notification.create([{
        userId: new mongoose.Types.ObjectId(notifyUserId),
        title: 'Transaction Funded',
        message: `Transaction ${transaction._id} has been funded with ₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })} and is now in escrow.`,
        transactionId: transaction._id.toString(),
        type: 'transaction',
        status: 'funded',
        createdAt: new Date(),
      }], { session });
    });
    await Promise.all(notificationPromises.filter(p => p));

    const io = req.app.get('io');
    io.to(userId).emit('balanceUpdate', {
      balance: buyerWallet.balance,
      transaction: {
        amount,
        reference: `FUND-${transaction._id}`,
      },
    });

    usersToNotify.forEach((userId) => {
      if (mongoose.Types.ObjectId.isValid(userId)) {
        io.to(userId).emit('transactionUpdated', {
          transactionId: transaction._id,
          message: 'Transaction has been funded.',
          status: 'funded',
        });
      }
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

    const amount = paystackResponse.data.data.amount / 100;
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

    wallet.balance += amount;
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
      }, null, session);
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
        amount: Math.ceil(amount * 100),
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

    console.log('updatePaymentDetails called:', { transactionId, paymentAmount, userId });

    // Validate transaction ID
    if (!transactionId || !/^[0-9a-fA-F]{24}$/.test(transactionId)) {
      console.warn('Invalid transaction ID:', transactionId);
      return res.status(400).json({ success: false, error: 'Invalid transaction ID' });
    }

    // Find transaction with error handling
    let transaction;
    try {
      transaction = await Transaction.findById(transactionId);
    } catch (dbError) {
      console.error('Database error finding transaction:', dbError);
      return res.status(500).json({ success: false, error: 'Database error occurred while fetching transaction' });
    }

    if (!transaction) {
      console.warn('Transaction not found:', transactionId);
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }

    // Check creator permissions
    const isCreator = transaction.userId.toString() === userId;
    if (!isCreator) {
      console.log('Unauthorized update attempt:', { userId, transactionCreator: transaction.userId.toString() });
      return res.status(403).json({ success: false, error: 'Only the transaction creator can update payment details' });
    }

    // Validate transaction state
    if (transaction.locked) {
      console.log('Attempt to update locked transaction:', transactionId);
      return res.status(400).json({ success: false, error: 'Cannot update payment details for a funded transaction' });
    }

    if (transaction.status !== 'pending') {
      console.log('Attempt to update non-pending transaction:', { transactionId, status: transaction.status });
      return res.status(400).json({ success: false, error: 'Only pending transactions can be updated' });
    }

    // Validate payment amount
    if (!paymentAmount || isNaN(paymentAmount) || parseFloat(paymentAmount) <= 0) {
      console.log('Invalid payment amount:', paymentAmount);
      return res.status(400).json({ success: false, error: 'Invalid payment amount' });
    }

    // Update transaction
    try {
      transaction.paymentAmount = parseFloat(paymentAmount);
      transaction.productDetails.amount = parseFloat(paymentAmount);
      await transaction.save();
      console.log('Transaction updated successfully:', transactionId);
    } catch (dbError) {
      console.error('Database error saving transaction:', dbError);
      return res.status(500).json({ success: false, error: 'Database error occurred while saving transaction' });
    }

    // Emit socket event
    try {
      const io = req.app.get('io');
      const usersToNotify = [
        transaction.userId.toString(),
        ...transaction.participants.map(p => p.userId.toString()),
      ];
      usersToNotify.forEach(notifyUserId => {
        io.to(notifyUserId).emit('transactionUpdated', {
          transactionId: transaction._id,
          message: `Payment amount updated to ₦${parseFloat(paymentAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`,
        });
      });
      console.log('Socket event emitted to users:', usersToNotify);
    } catch (socketError) {
      console.error('Error emitting socket event:', socketError);
      // Continue despite socket error to avoid failing the request
    }

    return res.status(200).json({
      success: true,
      message: 'Payment details updated successfully',
      transaction,
    });
  } catch (error) {
    console.error('Error updating payment details:', error);
    return res.status(500).json({
      success: false,
      error: error.code === 'ECONNRESET'
        ? 'Network error occurred. Please try again.'
        : error.message || 'Internal server error',
    });
  }
};

// exports.confirmTransaction = async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();
//   try {
//     const { transactionId } = req.body;
//     const userId = req.user.id;

//     console.log('Confirm transaction request:', { transactionId, userId });

//     // Validate transaction ID
//     if (!mongoose.Types.ObjectId.isValid(transactionId)) {
//       console.warn('Invalid transaction ID:', transactionId);
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
//     }

//     const transaction = await Transaction.findById(transactionId)
//       .populate("userId", "firstName lastName email")
//       .populate("participants", "firstName lastName email")
//       .session(session);
//     if (!transaction) {
//       console.log('Transaction not found:', transactionId);
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: "Transaction not found" });
//     }

//     const isCreator = transaction.userId._id.toString() === userId;
//     const isParticipant = transaction.participants.some(
//       (p) => p._id.toString() === userId
//     );
//     if (!isCreator && !isParticipant) {
//       console.log('Unauthorized access:', { userId, transactionId });
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(403).json({ message: "Unauthorized to confirm this transaction" });
//     }

//     const isBuyer = (isCreator && transaction.selectedUserType === "buyer") ||
//       (isParticipant && transaction.selectedUserType === "seller");
//     console.log('User role:', { isBuyer, isCreator, isParticipant, selectedUserType: transaction.selectedUserType });

//     if (transaction.status !== "pending") {
//       console.log('Invalid transaction status:', transaction.status);
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: "Only pending transactions can be confirmed" });
//     }

//     if (!transaction.locked || !transaction.funded) {
//       console.log('Transaction not funded:', { locked: transaction.locked, funded: transaction.funded });
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: "Transaction must be funded before confirmation" });
//     }

//     // Check buyer's wallet balance before allowing confirmation
//     if (isBuyer) {
//       const buyerWallet = await Wallet.findOne({ userId }).session(session);
//       if (!buyerWallet) {
//         console.log('Buyer wallet not found:', { userId });
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(404).json({ message: "Buyer wallet not found" });
//       }
//       if (buyerWallet.balance < transaction.paymentAmount) {
//         console.log('Insufficient buyer wallet balance:', {
//           balance: buyerWallet.balance,
//           required: transaction.paymentAmount,
//         });
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(400).json({
//           message: "Insufficient funds in wallet to confirm transaction",
//           shortfall: transaction.paymentAmount - buyerWallet.balance,
//           balance: buyerWallet.balance,
//         });
//       }
//     }

//     if (isBuyer) {
//       if (transaction.buyerConfirmed) {
//         console.log('Buyer already confirmed:', transactionId);
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(400).json({ message: "Buyer has already confirmed this transaction" });
//       }
//       transaction.buyerConfirmed = true;
//     } else {
//       if (transaction.sellerConfirmed) {
//         console.log('Seller already confirmed:', transactionId);
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(400).json({ message: "Seller has already confirmed this transaction" });
//       }
//       transaction.sellerConfirmed = true;
//     }

//     let notificationMessage = "";
//     let notificationTitle = "";
//     const otherPartyId = isCreator
//       ? transaction.participants[0]?._id?.toString()
//       : transaction.userId._id.toString();

//     if (transaction.buyerConfirmed && transaction.sellerConfirmed) {
//       transaction.status = "completed";
//       transaction.payoutReleased = true;

//       const buyerWallet = await Wallet.findById(transaction.buyerWalletId).session(session);
//       const sellerWallet = await Wallet.findById(transaction.sellerWalletId).session(session);
//       if (!buyerWallet || !sellerWallet) {
//         console.log('Wallets not found:', {
//           buyerWalletId: transaction.buyerWalletId,
//           sellerWalletId: transaction.sellerWalletId,
//         });
//         await session.abortTransaction();
//         session.endSession();
//         return res.status(400).json({ message: "Buyer or seller wallet not found" });
//       }

//       // Transfer funds to seller
//       const payoutAmount = transaction.lockedAmount;
//       sellerWallet.balance += payoutAmount;
//       sellerWallet.transactions.push({
//         type: "deposit",
//         amount: payoutAmount,
//         reference: `PAYOUT-${transaction._id}`,
//         status: "completed",
//         metadata: {
//           purpose: "Transaction payout",
//           transactionId: transaction._id,
//         },
//         createdAt: new Date(),
//       });

//       await sellerWallet.save({ session });
//       console.log('Funds transferred to seller wallet:', {
//         sellerWalletId: sellerWallet._id,
//         amount: payoutAmount,
//         newBalance: sellerWallet.balance,
//       });

//       // Reset locked state after payout
//       transaction.locked = false;
//       transaction.lockedAmount = 0;

//       const io = req.app.get("io");
//       io.to(sellerWallet.userId.toString()).emit("balanceUpdate", {
//         balance: sellerWallet.balance,
//         transaction: {
//           amount: payoutAmount,
//           reference: `PAYOUT-${transaction._id}`,
//         },
//       });

//       notificationTitle = "Transaction Completed";
//       notificationMessage = `Transaction ${transaction._id} has been completed. Funds have been released to the seller.`;
//     } else {
//       notificationTitle = "Transaction Confirmation Pending";
//       notificationMessage = `Waiting for the other party to confirm transaction ${transaction._id}.`;
//     }

//     await transaction.save({ session });
//     console.log('Transaction updated:', {
//       transactionId: transaction._id,
//       status: transaction.status,
//       buyerConfirmed: transaction.buyerConfirmed,
//       sellerConfirmed: transaction.sellerConfirmed,
//       locked: transaction.locked,
//       lockedAmount: transaction.lockedAmount,
//     });

//     if (otherPartyId) {
//       const notification = new Notification({
//         userId: otherPartyId,
//         title: notificationTitle,
//         message: notificationMessage,
//         transactionId: transaction._id.toString(),
//         type: "confirmation",
//         status: transaction.status,
//       });

//       await notification.save({ session });
//       console.log('Notification created:', {
//         notificationId: notification._id,
//         userId: otherPartyId,
//         title: notificationTitle,
//         message: notificationMessage,
//       });

//       const io = req.app.get("io");
//       io.to(otherPartyId).emit("transactionUpdated", {
//         transactionId: transaction._id,
//         message: notificationMessage,
//         status: transaction.status,
//       });
//     }

//     if (transaction.status === "completed") {
//       const usersToNotify = [
//         transaction.userId._id.toString(),
//         ...transaction.participants.map((p) => p._id.toString()),
//       ];
//       const notificationPromises = usersToNotify.map((notifyUserId) =>
//         Notification.create({
//           userId: notifyUserId,
//           title: "Transaction Completed",
//           message: `Transaction ${transaction._id} has been completed. Funds have been released to the seller.`,
//           transactionId: transaction._id.toString(),
//           type: "confirmation",
//           status: "completed",
//         }, { session })
//       );

//       await Promise.all(notificationPromises);
//       console.log('Completion notifications sent to all parties:', usersToNotify);

//       const io = req.app.get("io");
//       usersToNotify.forEach((userId) => {
//         io.to(userId).emit("transactionCompleted", {
//           transactionId: transaction._id,
//           message: `Transaction ${transaction._id} has been completed.`,
//         });
//       });
//     }

//     await session.commitTransaction();
//     session.endSession();

//     return res.status(200).json({
//       message: transaction.status === "completed"
//         ? "Transaction completed successfully"
//         : "Confirmation recorded, waiting for other party",
//       transaction,
//     });
//   } catch (error) {
//     console.error("Error in confirmTransaction:", error);
//     await session.abortTransaction();
//     session.endSession();
//     return res.status(500).json({ message: "Internal server error", error: error.message });
//   }
// };

// Updated confirmTransaction controller
exports.confirmTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;

    console.log('Confirm transaction request:', { transactionId, userId });

    // Validate transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.warn('Invalid transaction ID:', transactionId);
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, error: 'Invalid transaction ID format' });
    }

    const transaction = await Transaction.findById(transactionId)
      .populate("userId", "firstName lastName email")
      .populate("participants.userId", "firstName lastName email")  // Fixed populate for participants
      .session(session);
    if (!transaction) {
      console.log('Transaction not found:', transactionId);
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p.userId._id.toString() === userId  // Fixed comparison
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

    if (!transaction.locked || !transaction.funded) {
      console.log('Transaction not funded:', { locked: transaction.locked, funded: transaction.funded });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Transaction must be funded before confirmation" });
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
      ? transaction.participants[0]?.userId?._id?.toString()  // Fixed access
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
      const payoutAmount = transaction.lockedAmount;
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
        ...transaction.participants.map((p) => p.userId._id.toString()),  // Fixed access
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