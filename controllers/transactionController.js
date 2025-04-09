const Transaction = require('../modules/Transactions');
const { v4: uuidv4 } = require('uuid');
const User = require("../modules/Users"); // Adjust the path if needed
const mongoose = require("mongoose");
const Chatroom = require('../modules/Chatroom');
const Notification = require('../modules/Notification');
const axios = require('axios');


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

    const buyerNotification = new Notification({
      userId: userId,
      title: 'New Transaction Created',
      message: `${paymentDescription}`,
      transactionId: newTransaction._id

    })

    await buyerNotification.save();

    // Log the notification to confirm it was created
    console.log('Notification created:', buyerNotification);

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
    const { transactionId } = req.params; // Get the transaction ID from the route params

    // Find the transaction by its ID
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Check if the transaction is already cancelled
    if (transaction.status === "completed") {
      return res.status(400).json({ message: "Transaction is already completed" });
    }

    // Update the transaction's status to cancelled
    transaction.status = "completed";
    await transaction.save(); // Save the updated transaction
    console.log('Transaction status updated to completed:', transaction);

    return res.status(200).json({
      // message: "Transaction successfully cancelled",
      message: `Transaction with ID ${transactionId} successfully completed`,
      transaction,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error" });
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

exports.submitWaybillDetails = async (req, res) => {
  const { transactionId } = req.body;
  const { item, price, shippingAddress, trackingNumber, deliveryDate } = req.body;
  const image = req.file; // File handling

  if (!item || !price || !shippingAddress || !trackingNumber || !deliveryDate) {
    return res.status(400).json({ error: "All required fields must be provided" });
  }

  try {
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Use the relative path to the image
    const imagePath = image ? `uploads/images/${image.filename}` : null;


    // Update waybill details
    transaction.waybillDetails = {
      item: item || null,
      // image: image ? image.path : null,
      image: imagePath,
      price: price || null,
      shippingAddress: shippingAddress || null,
      trackingNumber: trackingNumber || null,
      deliveryDate: deliveryDate || null,
    };

    await transaction.save();

    res.json(transaction);
  } catch (error) {
    console.error("Error submitting waybill details:", error);
    res.status(500).json({ error: "Server error" });
  }
};


exports.getWaybillDetails = async (req, res) => {
  const { transactionId } = req.params;

  try {
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Return the waybill details
    res.json(transaction.waybillDetails);
  } catch (error) {
    console.error("Error fetching waybill details:", error);
    res.status(500).json({ error: "Server error" });
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


// Cancel transaction controller
exports.cancelTransaction = async (req, res) => {
  try {
    const { transactionId } = req.params; // Get the transaction ID from the route params

    // Find the transaction by its ID
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Check if the transaction is already cancelled
    if (transaction.status === "cancelled") {
      return res.status(400).json({ message: "Transaction is already cancelled" });
    }

    // Update the transaction's status to cancelled
    transaction.status = "cancelled";
    await transaction.save(); // Save the updated transaction
    console.log('Transaction status updated to cancelled:', transaction);

    return res.status(200).json({
      // message: "Transaction successfully cancelled",
      message: `Transaction with ID ${transactionId} successfully canceled`,
      transaction,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// =============================================================================
// =============================================
// exports.initiatePayment = async (req, res) => {
//   console.log('Initiate payment request received');

//   const { amount, transactionId, email } = req.body;

//   // Log the received data to ensure it's correct
//   console.log(`Email: ${email}, Amount: ${amount}, Transaction ID: ${transactionId}`);

//   if (!email || !amount || !transactionId) {
//     return res.status(400).json({ message: "Missing required fields" });
//   }

//   try {
//     const response = await axios.post(
//       "https://api.paystack.co/transaction/initialize",
//       {
//         email,
//         amount: amount * 100,  // Convert to Kobo
//         metadata: { transactionId }
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,  // Paystack Secret Key
//         },
//       }
//     );

//     // Log the response from Paystack for debugging
//     console.log("Paystack response:", response.data);

//     // If Paystack call is successful

//     await Transaction.findByIdAndUpdate(transactionId, {
//       paymentReference: response.data.data.reference,
//     });


//     res.json({ authorization_url: response.data.data.authorization_url });
//   } catch (err) {
//     console.error("Payment initialization failed:", err);
//     console.error("Error details:", err.response ? err.response.data : err.message);
//     res.status(500).json({ message: "Payment initialization failed", error: err.response ? err.response.data : err.message });
//   }
// };
exports.initiatePayment = async (req, res) => {
  console.log('Initiate payment request received');

  const { amount, transactionId, email } = req.body;

  // Log the received data
  console.log(`Email: ${email}, Amount: ${amount}, Transaction ID: ${transactionId}`);

  // Check if all required fields are provided
  if (!email || !amount || !transactionId) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // Step 1: Validate transaction ID format
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      console.error("❌ Invalid transaction ID format:", transactionId);
      return res.status(400).json({ message: "Invalid transaction ID format" });
    }

    // Step 2: Find the transaction by ID
    // IMPORTANT: Using findById() looks for the MongoDB _id field
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      console.error("❌ Transaction not found with ID:", transactionId);
      return res.status(404).json({ message: "Transaction not found" });
    }

    console.log("✅ Found transaction:", transaction._id);

    // Step 3: Initialize payment with Paystack
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,  // Convert to Kobo
        metadata: {
          transactionId: transaction._id.toString(),
          // Add any other metadata you need
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
        },
      }
    );

    // Log the Paystack response
    console.log("Paystack response:", response.data);

    // Step 4: Save Paystack reference to the transaction
    transaction.paymentReference = response.data.data.reference;
    await transaction.save();

    console.log("✅ Saved payment reference:", transaction.paymentReference);

    // Return the authorization URL for the client
    res.json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference
    });
  } catch (err) {
    console.error("Payment initialization failed:", err);

    // Handle potential Axios response errors
    const errorMessage = err.response ? err.response.data : err.message;
    console.error("Error details:", errorMessage);

    res.status(500).json({
      message: "Payment initialization failed",
      error: errorMessage
    });
  }
};


// exports.handleWebhook = async (req, res) => {
//   try {
//     const event = req.body;
//     console.log("Webhook payload received:", event);

//     if (event.event === "charge.success") {
//       // Get the reference and metadata from the event
//       const reference = event.data.reference;
//       const metadata = event.data.metadata || {};
//       // const transactionId = metadata.transactionId;
//       const transactionId = event.data.metadata.transactionId;
//       console.log("Metadata from webhook:", event.data.metadata);

//       console.log(`Processing successful payment: Reference=${reference}, TransactionID=${transactionId}`);

//       // First try to find by the transactionId in metadata
//       let tx = null;
//       if (transactionId && mongoose.Types.ObjectId.isValid(transactionId)) {
//         tx = await Transaction.findById(transactionId);
//       }

//       // If not found by transactionId, try to find by reference
//       if (!tx) {
//         tx = await Transaction.findOneAndUpdate(
//           { "paymentReference": reference },
//           { 
//             "paymentReference": reference,
//             "status": "funded",
//             "funded": true
//           },
//           { new: true }
//         );
//       } else {
//         // Update the transaction if found by ID
//         tx.status = "funded";
//         tx.funded = true;
//         tx.paymentReference = reference;
//         await tx.save();
//       }



//       if (tx) {
//         console.log(`Transaction ${tx._id} marked as funded`);
//       } else {
//         console.log(`Warning: Could not find transaction for reference ${reference}`);
//       }
//     }

//     res.sendStatus(200);
//   } catch (error) {
//     console.error("Error in webhook handler:", error);
//     // Always return 200 to Paystack to acknowledge receipt
//     res.sendStatus(200);
//   }
// };

// Webhook Handler
exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;
    console.log("⚡ Webhook received:", event.event);

    // For detailed debugging
    console.log("Webhook payload:", JSON.stringify(event, null, 2));

    // Handle successful payments
    if (event.event === "charge.success") {
      const reference = event.data.reference;
      const metadata = event.data.metadata || {};
      const transactionId = metadata.transactionId;

      console.log("🔍 Payment success details:", {
        reference,
        transactionId,
      });

      let transaction = null;

      // Try to find transaction by ID from metadata
      if (transactionId && mongoose.Types.ObjectId.isValid(transactionId)) {
        console.log(`🔍 Searching by transactionId: ${transactionId}`);
        transaction = await Transaction.findById(transactionId);
        if (transaction) {
          console.log("✅ Found transaction by ID:", transaction._id);
        }
      }

      // If not found by ID, try by reference
      if (!transaction) {
        console.log(`🔍 Searching by paymentReference: ${reference}`);
        transaction = await Transaction.findOne({ paymentReference: reference });
        if (transaction) {
          console.log("✅ Found transaction by reference:", transaction._id);
        }
      }

      // Handle case where transaction is not found
      if (!transaction) {
        console.error(`❌ Transaction not found. Reference=${reference}, TransactionId=${transactionId}`);
        // Still return 200 to acknowledge receipt
        return res.status(200).json({
          message: "Webhook received, but transaction not found"
        });
      }

      // Check if already funded
      if (transaction.funded) {
        console.log("ℹ️ Transaction already marked as funded:", transaction._id);
        return res.status(200).json({ message: "Transaction already funded" });
      }

      // Update transaction status
      transaction.funded = true;
      // transaction.status = "funded";
      transaction.status = "completed"; 
      transaction.paymentStatus = "paid";
      transaction.paymentReference = reference;
      await transaction.save();

      console.log(`💰 Transaction ${transaction._id} marked as funded`);
      return res.status(200).json({ message: "Transaction updated successfully" });
    }

    // Always return 200 for all webhook events
    return res.status(200).json({ message: "Webhook received" });
  } catch (error) {
    console.error("🔥 Webhook error:", error);
    // Return 200 even if there's an error to acknowledge receipt
    return res.status(200).json({
      message: "Webhook received with processing error"
    });
  }
};


exports.checkTransactionFunded = async (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
    return res.status(400).json({
      funded: false,
      message: "Invalid transaction ID format"
    });
  }

  try {
    const transaction = await Transaction.findById(transactionId);

    if (!transaction) {
      return res.status(404).json({
        funded: false,
        message: "Transaction not found"
      });
    }

    res.json({
      funded: transaction.funded,
      status: transaction.status
    });
  } catch (error) {
    console.error("Error checking transaction status:", error);
    res.status(500).json({
      funded: false,
      message: "Error checking transaction status"
    });
  }
};

exports.confirmTransaction = async (req, res) => {
  const { reference } = req.body;
  const user = req.user;

  const tx = await Transaction.findOne({ paystackReference: reference });
  if (!tx) return res.status(404).json({ message: "Transaction not found" });

  if (user.role === 'buyer') tx.buyerConfirmed = true;
  if (user.role === 'seller') tx.sellerConfirmed = true;

  if (tx.buyerConfirmed && tx.sellerConfirmed) {
    tx.status = "confirmed";
    await tx.save();
    await triggerPayout(tx); // ⬇️ See next step
  } else {
    await tx.save();
  }

  res.status(200).json(tx);
};


// controllers/paymentController.js
const triggerPayout = async (transaction) => {
  const recipient = await axios.post("https://api.paystack.co/transferrecipient", {
    type: "nuban",
    name: transaction.sellerName,
    account_number: transaction.sellerAccountNumber,
    bank_code: transaction.sellerBankCode,
    currency: "NGN"
  }, {
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
    }
  });

  const transfer = await axios.post("https://api.paystack.co/transfer", {
    source: "balance",
    amount: transaction.amount * 100,
    recipient: recipient.data.data.recipient_code,
    reason: `Payout for transaction ${transaction._id}`
  }, {
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
    }
  });

  return transfer.data;
};
