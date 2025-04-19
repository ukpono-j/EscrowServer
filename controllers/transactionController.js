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
      paymentBankCode,
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
      paymentBankCode,
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
    // console.log('Notification created:', buyerNotification);

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
    })
      .populate('chatroomId') // Populate chatroomId to get chatroom details
      .populate('userId', 'firstName email') // Populate creator info
      .populate('participants', 'firstName email') // Populate participant info
      .sort({ createdAt: -1 });

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
    // console.log('Transaction status updated to completed:', transaction);

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


// exports.joinTransaction = async (req, res) => {
//   try {
//     const { transactionId } = req.body;
//     const { id: userId } = req.user;

//     console.log('Received transactionId:', transactionId);
//     console.log('Received userId:', userId);

//     if (!mongoose.Types.ObjectId.isValid(transactionId)) {
//       console.log('Invalid transaction ID');
//       return res.status(400).json({ error: "Invalid transaction ID" });
//     }

//     const transaction = await Transaction.findOne({ transactionId });
//     console.log('Found Transaction:', transaction);

//     if (!transaction) {
//       return res.status(404).json({ error: "Transaction not found" });
//     }

//     const isParticipant = transaction.participants.some(
//       (participant) => participant.toString() === userId.toString()
//     );

//     if (isParticipant) {
//       return res.status(400).json({ error: "User is already a participant in this transaction" });
//     }

//     transaction.participants.push(userId);
//     await transaction.save();

//     res.status(200).json({ message: "Successfully joined the transaction", transaction });
//   } catch (error) {
//     console.error("Error joining transaction:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// };

exports.joinTransaction = async (req, res) => {
  try {
    const { transactionId } = req.body;
    const { id: userId } = req.user;

    // console.log('Received transactionId:', transactionId);
    // console.log('Received userId:', userId);

    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      // console.log('Invalid transaction ID');
      return res.status(400).json({ error: "Invalid transaction ID" });
    }



    // Log the query being used
    // console.log(`Attempting to find transaction with ID: ${transactionId}`);

    // const transaction = await Transaction.findById(transactionId);
    // console.log('Found Transaction:', transaction);
    // Try finding by either _id or transactionId
    const transaction = await Transaction.findOne({
      $or: [
        { _id: transactionId },
        { transactionId: transactionId }
      ]
    });

    // console.log('Found Transaction:', transaction);

    if (!transaction) {
      // Check if any transactions exist at all (for debugging)
      const count = await Transaction.countDocuments();
      // console.log(`Total transactions in database: ${count}`);

      return res.status(404).json({
        error: "Transaction not found",
        requestedId: transactionId
      });
    }

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    // Filter out null values and check if user is already a participant
    const validParticipants = transaction.participants.filter(participant => participant !== null);
    const isParticipant = validParticipants.some(
      (participant) => participant.toString() === userId.toString()
    );

    if (isParticipant) {
      return res.status(400).json({ error: "User is already a participant in this transaction" });
    }

    // Handle the user type logic
    const creatorId = transaction.userId.toString();
    const creatorType = transaction.selectedUserType;

    // If the creator is a buyer, participant becomes seller and vice versa
    const participantType = creatorType === 'buyer' ? 'seller' : 'buyer';

    // Check if we already have the maximum allowed participants (creator + 1 participant)
    if (validParticipants.length >= 1 && validParticipants[0].toString() !== creatorId) {
      return res.status(400).json({ error: "Transaction already has the maximum number of participants" });
    }

    // Add participant to the transaction
    transaction.participants = validParticipants; // Clean up null values
    transaction.participants.push(userId);

    // Update transaction status when participant joins
    transaction.status = "pending";

    // Update transaction status when participant joins
    // if (!transaction.sellerConfirmed && participantType === 'seller') {
    //   transaction.sellerConfirmed = true;
    // }

    // if (!transaction.buyerConfirmed && participantType === 'buyer') {
    //   transaction.buyerConfirmed = true;
    // }

    await transaction.save();

    res.status(200).json({
      message: "Successfully joined the transaction",
      transaction,
      role: participantType // Return the role that the joining user will play
    });

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
    // console.log("Received chatroomId:", chatroomId); // Log the received chatroomId

    if (!mongoose.Types.ObjectId.isValid(chatroomId)) {
      // console.log("Invalid chatroomId:", chatroomId); // Log invalid chatroomId case
      return res.status(400).json({ message: "Invalid chatroom ID" });
    }

    const transaction = await Transaction.findOne({ chatroomId: chatroomId })
      .populate('participants')
      .exec();

    if (!transaction) {
      // console.log("Transaction not found for chatroomId:", chatroomId); // Log transaction not found
      return res.status(404).json({ message: "Transaction not found" });
    }

    // console.log("Transaction found:", transaction); // Log the found transaction
    res.status(200).json(transaction);
  } catch (error) {
    console.error("Error fetching transaction:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};


exports.createChatRoom = async (req, res) => {
  const { transactionId } = req.body;
  const userId = req.user.id;

  // console.log("Received transactionId:", transactionId);
  // console.log("Authenticated userId:", userId);


  try {
    // Validate request body
    if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
      // console.log("Invalid transaction ID:", transactionId);
      return res.status(400).json({ message: "Invalid transaction ID" });
    }

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      // console.log("Invalid user ID:", userId);
      return res.status(400).json({ message: "Invalid user ID" });
    }

    // Find the transaction
    let transaction = await Transaction.findById(transactionId).populate('participants');
    if (!transaction) {
      // console.log("Transaction not found for ID:", transactionId);
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Check if chatroom already exists
    if (transaction.chatroomId) {
      // console.log("Chatroom already exists for transaction ID:", transactionId);
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
    // console.log('Transaction status updated to cancelled:', transaction);

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
  // console.log('Initiate payment request received');

  const { amount, transactionId, email } = req.body;

  // Log the received data
  // console.log(`Email: ${email}, Amount: ${amount}, Transaction ID: ${transactionId}`);

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

    // console.log("✅ Found transaction:", transaction._id);

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
    // console.log("Paystack response:", response.data);

    // Step 4: Save Paystack reference to the transaction
    transaction.paymentReference = response.data.data.reference;
    await transaction.save();

    // console.log("✅ Saved payment reference:", transaction.paymentReference);

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
    // console.log("⚡ Webhook received:", event.event);

    // For detailed debugging
    // console.log("Webhook payload:", JSON.stringify(event, null, 2));

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
        // console.log(`🔍 Searching by transactionId: ${transactionId}`);
        transaction = await Transaction.findById(transactionId);
        if (transaction) {
          // console.log("✅ Found transaction by ID:", transaction._id);
        }
      }

      // If not found by ID, try by reference
      if (!transaction) {
        // console.log(`🔍 Searching by paymentReference: ${reference}`);
        transaction = await Transaction.findOne({ paymentReference: reference });
        if (transaction) {
          // console.log("✅ Found transaction by reference:", transaction._id);
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
        // console.log("ℹ️ Transaction already marked as funded:", transaction._id);
        return res.status(200).json({ message: "Transaction already funded" });
      }

      // Update transaction status
      transaction.funded = true;
      // transaction.status = "funded";
      // transaction.status = "completed";
      transaction.paymentStatus = "paid";
      transaction.paymentReference = reference;
      await transaction.save();

      // console.log(`💰 Transaction ${transaction._id} marked as funded`);
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
      // status: transaction.status
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
  try {
    const { transactionId } = req.body;
    const user = req.user;

    // console.log("confirmTransaction controller, Authenticated User:", user.email);

    // Check if user is defined
    if (!user || !user._id) {
      return res.status(401).json({ message: "User not authenticated or user ID missing" });
    }

    // Validate the transaction ID
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
      return res.status(400).json({ message: "Invalid transaction ID format" });
    }

    // Find the transaction and populate participant details
    // const transaction = await Transaction.findById(transactionId)
    //   .populate('userId', 'name email')
    //   .populate('participants', 'name email');

    // Find the transaction and populate participant details
    const transaction = await Transaction.findById(transactionId)
      .populate('userId', 'firstName lastName email')
      .populate('participants', 'firstName lastName email');

    if (!transaction) {
      return res.status(404).json({ message: "Transaction not found" });
    }

    // Check if transaction has userId before comparing
    if (!transaction.userId) {
      return res.status(400).json({ message: "Transaction has no user ID" });
    }

    // // If user is the creator and there are no participants yet
    // if (
    //   user._id.toString() === transaction.userId.toString() &&
    //   (!transaction.participants || transaction.participants.length === 0)
    // ) {
    //   return res.status(400).json({
    //     message: "There is no participant in this transaction. Please wait for someone to join."
    //   });
    // }

    // Convert user ID to string for consistent comparison
    const userIdString = user.id.toString();

    const creatorIdString = transaction.userId._id ? transaction.userId._id.toString() : transaction.userId.toString();

    // Output for debugging
    // console.log("User ID (from token):", userIdString);
    // console.log("Transaction creator ID:", creatorIdString);
    // console.log("Participant IDs in transaction:", transaction.participants.map(p => p._id ? p._id.toString() : 'Invalid participant'));


    // If user is the creator and there are no participants yet
    if (userIdString === creatorIdString &&
      (!transaction.participants || transaction.participants.length === 0)) {
      return res.status(400).json({
        message: "There is no participant in this transaction. Please wait for someone to join."
      });
    }
    const isCreator = userIdString === creatorIdString;

    // Determine user type and update appropriate confirmation flag
    if (isCreator) {
      // This is the transaction creator
      if (transaction.selectedUserType === "buyer") {
        transaction.buyerConfirmed = true;
        // console.log("Buyer confirmed transaction:", transactionId);
      } else if (transaction.selectedUserType === "seller") {
        transaction.sellerConfirmed = true;
        // console.log("Seller confirmed transaction:", transactionId);
      }
    } else {
      // This is the participant (not the creator)
      if (transaction.selectedUserType === "buyer") {
        // If creator is buyer, other party is seller
        transaction.sellerConfirmed = true;
        // console.log("Seller confirmed transaction:", transactionId);
      } else if (transaction.selectedUserType === "seller") {
        // If creator is seller, other party is buyer
        transaction.buyerConfirmed = true;
        // console.log("Buyer confirmed transaction:", transactionId);
      }
    }


    // Check if both parties have confirmed
    if (transaction.buyerConfirmed && transaction.sellerConfirmed && !transaction.payoutReleased) {
      transaction.status = "completed";
      transaction.payoutReleased = true;

      // Save before triggering payout to prevent duplicate payouts
      await transaction.save();

      // before the triggerPayout call
      console.log("About to trigger payout for transaction:", {
        transactionId: transaction._id,
        amount: transaction.paymentAmount,
        isFunded: transaction.funded,
        bankDetails: {
          name: transaction.paymentName,
          accountNumber: transaction.paymentAccountNumber,
          bankCode: transaction.paymentBankCode
        }
      });

      // Trigger payout to seller
      try {
        const payoutResult = await triggerPayout(transaction);
        // console.log("Payout initiated:", payoutResult);

        // Optionally update the transaction with payout reference
        if (payoutResult && payoutResult.data && payoutResult.data.transfer_code) {
          transaction.payoutReference = payoutResult.data.transfer_code;
          await transaction.save();
        }

        return res.status(200).json({
          message: "Transaction completed and payout initiated",
          transaction,
          buyerConfirmed: transaction.buyerConfirmed,
          sellerConfirmed: transaction.sellerConfirmed,
          status: transaction.status
        });
      } catch (payoutError) {
        console.error("Payout failed:", payoutError);

        // Update transaction to reflect payout failure but keep completed status
        transaction.payoutError = payoutError.message;
        await transaction.save();

        // Create a manual task for admin review
        try {
          // Here you would normally create a task for admin
          // console.log("Creating admin review task for failed payout of transaction:", transaction._id);
          // await AdminTask.create({ type: 'PAYOUT_FAILURE', transactionId: transaction._id, error: payoutError.message });
        } catch (err) {
          console.error("Failed to create admin task:", err);
        }

        // Still mark as completed but note the payout failure
        return res.status(200).json({
          message: "Transaction completed but payout failed. Admin will review.",
          transaction,
          buyerConfirmed: transaction.buyerConfirmed,
          sellerConfirmed: transaction.sellerConfirmed,
          status: transaction.status,
          payoutError: payoutError.message
        });
      }
    } else {
      // Save transaction with updated confirmation status
      await transaction.save();

      return res.status(200).json({
        message: "Confirmation received",
        buyerConfirmed: transaction.buyerConfirmed,
        sellerConfirmed: transaction.sellerConfirmed,
        status: transaction.status
      });
    }
  } catch (error) {
    console.error("Error in confirmTransaction:", error);
    return res.status(500).json({
      message: "Server error processing confirmation",
      error: error.message
    });
  }
};



// Function to fetch banks from Paystack
exports.getBanks = async (req, res) => {
  try {
    // Set CORS headers specifically for this endpoint
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, auth-token");
    
    if (!process.env.PAYSTACK_SECRET) {
      console.error("PAYSTACK_SECRET is not defined in environment variables");
      return res.status(500).json({ 
        status: false, 
        message: 'Server configuration error',
        // Return empty data array instead of nothing
        data: [] 
      });
    }

    const response = await axios.get(
      'https://api.paystack.co/bank',
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
        },
        // Add timeout to prevent hanging requests
        timeout: 8000
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('Error fetching banks:', error);
    // Return a structured response with empty data array
    return res.status(500).json({
      status: false,
      message: 'Server error while fetching banks',
      error: error.message,
      data: []
    });
  }
};

// First, get the list of banks to find the correct code
const getBankCode = async (bankName) => {
  try {
    const response = await axios.get(
      "https://api.paystack.co/bank",
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
        }
      }
    );

    if (response.data.status) {
      // Find the bank with matching name (case insensitive)
      const bankData = response.data.data.find(
        bank => bank.name.toLowerCase() === bankName.toLowerCase()
      );

      return bankData ? bankData.code : null;
    }
    return null;
  } catch (error) {
    console.error("Error fetching bank list:", error);
    return null;
  }
};

const triggerPayout = async (transaction) => {
  try {
    // Validate all required fields are present
    if (!transaction.paymentName) {
      throw new Error("Missing payment name for transaction");
    }
    if (!transaction.paymentAccountNumber) {
      throw new Error("Missing account number for transaction");
    }
    if (!transaction.paymentBankCode) {
      throw new Error("Missing bank code for transaction");
    }
    if (!transaction.paymentAmount || transaction.paymentAmount <= 0) {
      throw new Error("Invalid payment amount for transaction");
    }

    console.log("Creating transfer recipient with details:", {
      type: "nuban",
      name: transaction.paymentName,
      account_number: transaction.paymentAccountNumber,
      bank_code: transaction.paymentBankCode,
      amount: transaction.paymentAmount * 100
    });

    // Enhanced axios config with timeout
    const axiosConfig = {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
      },
      timeout: 30000 // 30 seconds timeout
    };



    // First, we need to create a transfer recipient with retry logic
    // console.log("Creating transfer recipient for transaction:", transaction._id);

    // Make sure we have the correct bank code
    const bankCode = transaction.paymentBankCode;
    if (!bankCode) {
      throw new Error("Missing bank code for transaction");
    }

    let recipientResponse;
    const maxRetries = 3;
    let retryCount = 0;

    // Get participant details (assuming this is the seller)
    // You'll need to adapt this based on how you store seller bank details
    // This may require a query to your User model to get bank details

    // For this example, I'm assuming the seller bank details are stored in the transaction
    // const recipientResponse = await axios.post(
    //   "https://api.paystack.co/transferrecipient",
    //   {
    //     type: "nuban",
    //     name: transaction.paymentName, // Update with actual seller name field
    //     account_number: transaction.paymentAccountNumber,
    //     bank_code: transaction.paymentBankCode, // Make sure this is the bank code, not the name
    //     currency: "NGN"
    //   },
    //   {
    //     headers: {
    //       Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
    //     }
    //   }
    // );

    while (retryCount < maxRetries) {
      try {
        recipientResponse = await axios.post(
          "https://api.paystack.co/transferrecipient",
          {
            type: "nuban",
            name: transaction.paymentName,
            account_number: transaction.paymentAccountNumber,
            bank_code: transaction.paymentBankCode,
            currency: "NGN"
          },
          axiosConfig
        );

        // If request succeeded, break the retry loop
        break;
      } catch (error) {
        retryCount++;
        // console.log(`Recipient creation attempt ${retryCount} failed:`, error.message);

        if (retryCount >= maxRetries) {
          throw new Error(`Failed to create transfer recipient after ${maxRetries} attempts: ${error.message}`);
        }

        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }

    if (!recipientResponse.data.status) {
      throw new Error("Failed to create transfer recipient: " +
        (recipientResponse.data.message || "Unknown error"));
    }

    const recipientCode = recipientResponse.data.data.recipient_code;
    // console.log("Transfer recipient created with code:", recipientCode);

    // Now initiate the transfer with retry logic
    let transferResponse;
    retryCount = 0;
    // const transferResponse = await axios.post(
    //   "https://api.paystack.co/transfer",
    //   {
    //     source: "balance",
    //     amount: transaction.paymentAmount * 100, // Convert to kobo
    //     recipient: recipientCode,
    //     reason: `Payout for transaction ${transaction._id}`
    //   },
    //   {
    //     headers: {
    //       Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
    //     }
    //   }
    // );

    while (retryCount < maxRetries) {
      try {
        transferResponse = await axios.post(
          "https://api.paystack.co/transfer",
          {
            source: "balance",
            amount: transaction.paymentAmount * 100, // Convert to kobo
            recipient: recipientCode,
            reason: `Payout for transaction ${transaction._id}`
          },
          axiosConfig
        );

        // If request succeeded, break the retry loop
        break;
      } catch (error) {
        retryCount++;
        // console.log(`Transfer initiation attempt ${retryCount} failed:`, error.message);

        if (retryCount >= maxRetries) {
          throw new Error(`Failed to initiate transfer after ${maxRetries} attempts: ${error.message}`);
        }

        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }


    console.log("Transfer request details:", {
      source: "balance",
      amount: transaction.paymentAmount * 100,
      recipient: recipientCode,
      reason: `Payout for transaction ${transaction._id}`
    });

    // console.log("Transfer response full data:", transferResponse.data);

    if (!transferResponse.data.status) {
      throw new Error("Failed to initiate transfer: " +
        (transferResponse.data.message || "Unknown error"));
    }

    // console.log("Transfer initiated successfully:", transferResponse.data);
    return transferResponse.data;
  } catch (error) {
    console.error("Error in triggerPayout:", error);
    throw error;
  }
};



// Function to verify bank account
exports.verifyBankAccount = async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;

    if (!account_number || !bank_code) {
      return res.status(400).json({ 
        status: false, 
        message: 'Account number and bank code are required' 
      });
    }

    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`
        },
        timeout: 8000
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('Error verifying bank account:', error);
    // More descriptive error messages
    let message = 'Failed to verify account';
    if (error.response && error.response.data) {
      message = error.response.data.message || message;
    }
    
    return res.status(error.response?.status || 500).json({
      status: false,
      message: message
    });
  }
};
