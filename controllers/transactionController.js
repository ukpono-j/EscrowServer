const Transaction = require("../modules/Transactions");
const User = require("../modules/Users");
const Chatroom = require("../modules/Chatroom");
const Wallet = require("../modules/wallet");
const Notification = require("../modules/Notification");
const mongoose = require("mongoose");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

exports.createTransaction = async (req, res) => {
  const {
    paymentName,
    paymentBank,
    paymentAccountNumber,
    email,
    paymentAmount,
    paymentDescription,
    selectedUserType,
    paymentBankCode,
  } = req.body;
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
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

    const transaction = new Transaction({
      userId,
      paymentName,
      paymentBank: selectedUserType === "buyer" ? "Pending" : paymentBank,
      paymentAccountNumber: selectedUserType === "buyer" ? 0 : paymentAccountNumber,
      email,
      paymentAmount,
      productDetails: {
        description: paymentDescription,
        amount: parseFloat(paymentAmount),
      },
      selectedUserType,
      paymentBankCode: selectedUserType === "buyer" ? "000" : paymentBankCode,
      buyerWalletId: selectedUserType === "buyer" ? wallet._id : null,
      sellerWalletId: selectedUserType === "seller" ? wallet._id : null,
      status: "pending",
    });

    await transaction.save();

    const io = req.app.get("io");
    io.to(userId).emit("transactionCreated", {
      transactionId: transaction._id,
      message: "Transaction created successfully",
    });

    return res.status(201).json({ data: { message: "Transaction created successfully", transactionId: transaction._id } });
  } catch (error) {
    console.error("Error creating transaction:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};


exports.getUserTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const transactions = await Transaction.find({
      $or: [{ userId }, { participants: userId }],
    })
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");
    console.log('Transactions fetched:', transactions.length); // Debug log
    return res.status(200).json({ data: transactions });
  } catch (error) {
    console.error("Error fetching transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCompletedTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const transactions = await Transaction.find({
      $or: [{ userId }, { participants: userId }],
      status: "completed",
    })
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");
    console.log('Completed transactions fetched:', transactions.length);
    return res.status(200).json({ data: transactions });
  } catch (error) {
    console.error("Error fetching completed transactions:", error);
    return res.status(500).json({ message: "Internal server error" });
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
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    const canPreview = transaction.status === "pending" && transaction.participants.length === 0;

    if (!isCreator && !isParticipant && !canPreview) {
      return res.status(403).json({ message: "Unauthorized to view this transaction" });
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
      return res.status(200).json({ data: limitedTransaction });
    }

    return res.status(200).json({ data: transaction });
  } catch (error) {
    console.error("Error fetching transaction by ID:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.cancelTransaction = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);

    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to cancel this transaction" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be cancelled" });
    }

    if (transaction.locked && transaction.buyerWalletId) {
      const buyerWallet = await Wallet.findById(transaction.buyerWalletId);
      if (buyerWallet) {
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
        await buyerWallet.save();

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
    await transaction.save();

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

    return res.status(200).json({ message: "Transaction cancelled successfully" });
  } catch (error) {
    console.error("Error cancelling transaction:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.joinTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ message: "You cannot join your own transaction" });
    }

    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ message: "You are already a participant" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be joined" });
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

    if (transaction.selectedUserType === "buyer") {
      transaction.sellerWalletId = wallet._id;
    } else {
      transaction.buyerWalletId = wallet._id;
    }

    transaction.participants.push(userId);
    await transaction.save();

    // Notify the creator
    const creatorId = transaction.userId.toString();
    const notification = new Notification({
      userId: creatorId,
      title: "User Joined Transaction",
      message: `A user has joined your transaction ${transaction._id}.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "accepted",
    });
    await notification.save();

    const io = req.app.get("io");
    io.to(creatorId).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: "A user has joined your transaction.",
    });

    return res.status(200).json({ message: "Joined transaction successfully", role: transaction.selectedUserType === "buyer" ? "seller" : "buyer" });
  } catch (error) {
    console.error("Error joining transaction:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.acceptAndUpdateTransaction = async (req, res) => {
  try {
    const { transactionId, description, price } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ message: "You cannot join your own transaction" });
    }

    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ message: "You are already a participant" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be joined" });
    }

    // Update transaction details
    transaction.productDetails.description = description;
    transaction.productDetails.amount = parseFloat(price);
    transaction.paymentAmount = parseFloat(price);

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

    if (transaction.selectedUserType === "buyer") {
      transaction.sellerWalletId = wallet._id;
    } else {
      transaction.buyerWalletId = wallet._id;
    }

    transaction.participants.push(userId);
    await transaction.save();

    // Notify the creator
    const creatorId = transaction.userId.toString();
    const notification = new Notification({
      userId: creatorId,
      title: "User Joined and Updated Transaction",
      message: `A user has joined and updated your transaction ${transaction._id}.`,
      transactionId: transaction._id.toString(),
      type: "transaction",
      status: "accepted",
    });
    await notification.save();

    const io = req.app.get("io");
    io.to(creatorId).emit("transactionUpdated", {
      transactionId: transaction._id,
      message: "A user has joined and updated your transaction.",
    });

    return res.status(200).json({ message: "Joined transaction successfully", role: transaction.selectedUserType === "buyer" ? "seller" : "buyer" });
  } catch (error) {
    console.error("Error accepting and updating transaction:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.rejectTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    if (transaction.userId.toString() === userId) {
      return res.status(400).json({ message: "You cannot reject your own transaction" });
    }

    if (transaction.participants.includes(userId)) {
      return res.status(400).json({ message: "You are already a participant" });
    }

    // Notify the creator
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

    return res.status(200).json({ message: "Transaction rejected" });
  } catch (error) {
    console.error("Error rejecting transaction:", error);
    return res.status(500).json({ message: "Internal server error" });
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

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);
    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to create chatroom for this transaction" });
    }

    if (transaction.chatroomId) {
      return res.status(200).json({ chatroomId: transaction.chatroomId });
    }

    const chatroom = new Chatroom({
      transactionId,
      participants: [transaction.userId, ...transaction.participants],
      messages: [],
    });

    await chatroom.save();
    transaction.chatroomId = chatroom._id;
    await transaction.save();

    return res.status(201).json({ chatroomId: chatroom._id });
  } catch (error) {
    console.error("Error creating chatroom:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// exports.getTransactionById = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const userId = req.user.id;

//     const transaction = await Transaction.findById(id)
//       .populate("userId", "firstName lastName email")
//       .populate("participants", "firstName lastName email");

//     if (!transaction) {
//       return res.status(404).json({ message: "Transaction not found" });
//     }

//     const isCreator = transaction.userId._id.toString() === userId;
//     const isParticipant = transaction.participants.some(
//       (p) => p._id.toString() === userId
//     );

//     if (!isCreator && !isParticipant) {
//       return res.status(403).json({ message: "Unauthorized to view this transaction" });
//     }

//     return res.status(200).json(transaction);
//   } catch (error) {
//     console.error("Error fetching transaction by ID:", error);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// };

exports.getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(id)
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );

    // Allow preview for authenticated users if the transaction is pending and has no participants
    const canPreview = transaction.status === "pending" && transaction.participants.length === 0;

    if (!isCreator && !isParticipant && !canPreview) {
      return res.status(403).json({ message: "Unauthorized to view this transaction" });
    }

    // If the user can only preview (not a creator or participant), return limited fields
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
      return res.status(200).json(limitedTransaction);
    }

    // Otherwise, return the full transaction details for creators and participants
    return res.status(200).json(transaction);
  } catch (error) {
    console.error("Error fetching transaction by ID:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.submitWaybillDetails = async (req, res) => {
  try {
    const { transactionId, item, price, shippingAddress, trackingNumber, deliveryDate } = req.body;
    const userId = req.user.id;
    const image = req.file ? req.file.path : null;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);
    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to submit waybill details" });
    }

    const isSeller = (isCreator && transaction.selectedUserType === "seller") ||
      (isParticipant && transaction.selectedUserType === "buyer");
    if (!isSeller) {
      return res.status(403).json({ message: "Only the seller can submit waybill details" });
    }

    transaction.waybillDetails = {
      item,
      image,
      price: parseFloat(price),
      shippingAddress,
      trackingNumber,
      deliveryDate,
    };
    transaction.proofOfWaybill = "pending";
    await transaction.save();

    const io = req.app.get("io");
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        message: "Waybill details have been submitted.",
      });
    });

    return res.status(200).json({ message: "Waybill details submitted successfully" });
  } catch (error) {
    console.error("Error submitting waybill details:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getWaybillDetails = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);
    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to view waybill details" });
    }

    return res.status(200).json({ waybillDetails: transaction.waybillDetails });
  } catch (error) {
    console.error("Error fetching waybill details:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getTransactionByChatroomId = async (req, res) => {
  try {
    const { chatroomId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findOne({ chatroomId })
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to view this transaction" });
    }

    return res.status(200).json(transaction);
  } catch (error) {
    console.error("Error fetching transaction by chatroom ID:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.fundTransactionWithWallet = async (req, res) => {
  try {
    const { transactionId, amount } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    const isParticipant = transaction.participants.includes(userId);
    if (!isCreator && !isParticipant) {
      return res.status(403).json({ message: "Unauthorized to fund this transaction" });
    }

    const isBuyer = (isCreator && transaction.selectedUserType === "buyer") ||
      (isParticipant && transaction.selectedUserType === "seller");
    if (!isBuyer) {
      return res.status(403).json({ message: "Only the buyer can fund the transaction" });
    }

    if (transaction.locked) {
      return res.status(400).json({ message: "Transaction is already funded" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be funded" });
    }

    let buyerWallet = await Wallet.findOne({ userId });
    if (!buyerWallet) {
      return res.status(404).json({ message: "Buyer wallet not found" });
    }

    if (buyerWallet.balance < amount) {
      return res.status(400).json({ message: "Insufficient funds in wallet" });
    }

    buyerWallet.balance -= amount;
    buyerWallet.transactions.push({
      type: "withdrawal",
      amount,
      reference: `FUND-${transaction._id}`,
      status: "completed",
      metadata: {
        purpose: "Transaction funding",
        transactionId: transaction._id,
      },
      createdAt: new Date(),
    });

    await buyerWallet.save();

    transaction.locked = true;
    transaction.lockedAmount = amount;
    transaction.buyerWalletId = buyerWallet._id;
    transaction.funded = true;
    await transaction.save();

    const io = req.app.get("io");
    io.to(userId).emit("balanceUpdate", {
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
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        message: "Transaction has been funded.",
      });
    });

    return res.status(200).json({ message: "Transaction funded successfully" });
  } catch (error) {
    console.error("Error funding transaction:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.updatePaymentDetails = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { paymentBank, paymentAccountNumber, selectedBankCode, paymentAmount, paymentDescription } = req.body;
    const userId = req.user.id;

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId.toString() === userId;
    if (!isCreator) {
      return res.status(403).json({ message: "Only the transaction creator can update payment details" });
    }

    if (transaction.locked) {
      return res.status(400).json({ message: "Cannot update payment details for a funded transaction" });
    }

    if (transaction.status !== "pending") {
      return res.status(400).json({ message: "Only pending transactions can be updated" });
    }

    transaction.paymentBank = paymentBank;
    transaction.paymentAccountNumber = paymentAccountNumber;
    transaction.paymentBankCode = selectedBankCode;
    transaction.paymentAmount = paymentAmount;
    transaction.productDetails = {
      description: paymentDescription,
      amount: parseFloat(paymentAmount),
    };
    await transaction.save();

    const io = req.app.get("io");
    const usersToNotify = [
      transaction.userId.toString(),
      ...transaction.participants.map((p) => p.toString()),
    ];
    usersToNotify.forEach((userId) => {
      io.to(userId).emit("transactionUpdated", {
        transactionId: transaction._id,
        message: "Payment details have been updated.",
      });
    });

    return res.status(200).json({ message: "Payment details updated successfully" });
  } catch (error) {
    console.error("Error updating payment details:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.confirmTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.id;

    console.log('Confirm transaction request:', { transactionId, userId });

    const transaction = await Transaction.findById(transactionId)
      .populate("userId", "firstName lastName email")
      .populate("participants", "firstName lastName email");
    if (!transaction) {
      console.log('Transaction not found:', transactionId);
      return res.status(404).json({ message: "Transaction not found" });
    }

    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(
      (p) => p._id.toString() === userId
    );
    if (!isCreator && !isParticipant) {
      console.log('Unauthorized access:', { userId, transactionId });
      return res.status(403).json({ message: "Unauthorized to confirm this transaction" });
    }

    const isBuyer = (isCreator && transaction.selectedUserType === "buyer") ||
      (isParticipant && transaction.selectedUserType === "seller");
    console.log('User role:', { isBuyer, isCreator, isParticipant, selectedUserType: transaction.selectedUserType });

    if (transaction.status !== "pending") {
      console.log('Invalid transaction status:', transaction.status);
      return res.status(400).json({ message: "Only pending transactions can be confirmed" });
    }

    if (!transaction.locked || !transaction.funded) {
      console.log('Transaction not funded:', { locked: transaction.locked, funded: transaction.funded });
      return res.status(400).json({ message: "Transaction must be funded before confirmation" });
    }

    if (isBuyer) {
      if (transaction.buyerConfirmed) {
        console.log('Buyer already confirmed:', transactionId);
        return res.status(400).json({ message: "Buyer has already confirmed this transaction" });
      }
      transaction.buyerConfirmed = true;
    } else {
      if (transaction.sellerConfirmed) {
        console.log('Seller already confirmed:', transactionId);
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

      const buyerWallet = await Wallet.findById(transaction.buyerWalletId);
      const sellerWallet = await Wallet.findById(transaction.sellerWalletId);
      if (!buyerWallet || !sellerWallet) {
        console.log('Wallets not found:', {
          buyerWalletId: transaction.buyerWalletId,
          sellerWalletId: transaction.sellerWalletId,
        });
        return res.status(400).json({ message: "Buyer or seller wallet not found" });
      }

      sellerWallet.balance += transaction.lockedAmount;
      sellerWallet.transactions.push({
        type: "deposit",
        amount: transaction.lockedAmount,
        reference: `PAYOUT-${transaction._id}`,
        status: "completed",
        metadata: {
          purpose: "Transaction payout",
          transactionId: transaction._id,
        },
        createdAt: new Date(),
      });

      await sellerWallet.save();
      console.log('Funds transferred to seller wallet:', {
        sellerWalletId: sellerWallet._id,
        amount: transaction.lockedAmount,
        newBalance: sellerWallet.balance,
      });

      const io = req.app.get("io");
      io.to(sellerWallet.userId.toString()).emit("balanceUpdate", {
        balance: sellerWallet.balance,
        transaction: {
          amount: transaction.lockedAmount,
          reference: `PAYOUT-${transaction._id}`,
        },
      });

      notificationTitle = "Transaction Completed";
      notificationMessage = `Transaction ${transaction._id} has been completed. Funds have been released to the seller.`;
    } else {
      notificationTitle = "Transaction Confirmation Pending";
      notificationMessage = `Waiting for the other party to confirm transaction ${transaction._id}.`;
    }

    await transaction.save();
    console.log('Transaction updated:', {
      transactionId: transaction._id,
      status: transaction.status,
      buyerConfirmed: transaction.buyerConfirmed,
      sellerConfirmed: transaction.sellerConfirmed,
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

      await notification.save();
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
        })
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

    return res.status(200).json({
      message: transaction.status === "completed"
        ? "Transaction completed successfully"
        : "Confirmation recorded, waiting for other party",
      transaction,
    });
  } catch (error) {
    console.error("Error in confirmTransaction:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

module.exports = exports;