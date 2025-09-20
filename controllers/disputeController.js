// controllers/disputeController.js
const mongoose = require('mongoose');
const Dispute = require('../modules/Dispute');
const DisputeMessage = require('../modules/DisputeMessage');
const Transaction = require('../modules/Transactions');
const User = require('../modules/Users');
const Notification = require('../modules/Notification');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

let transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true' || false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});


// Helper function to get user role in a transaction
const getUserRoleInTransaction = (userId, transaction) => {
  if (!userId || !transaction) return 'Unknown';

  const userIdString = userId.toString();
  const creatorId = transaction.userId?._id?.toString() || transaction.userId?.toString();

  // Check if user is the transaction creator
  if (userIdString === creatorId) {
    // Return the creator's selected user type (buyer or seller) with proper capitalization
    return transaction.selectedUserType === 'buyer' ? 'Buyer' : 'Seller';
  }

  // Check if user is a participant
  const participant = transaction.participants?.find(p =>
    (p.userId?._id?.toString() || p.userId?.toString()) === userIdString
  );

  if (participant && participant.role) {
    // Return the participant's role (buyer or seller) with proper capitalization
    return participant.role.charAt(0).toUpperCase() + participant.role.slice(1);
  }

  return 'Unknown';
};

// Create a new dispute
exports.createDispute = async (req, res) => {
  try {
    const { transactionId, reason, description } = req.body;
    const { id: userId } = req.user;
    const files = req.files || [];

    console.log('Creating dispute:', { userId, transactionId, reason });

    // Validate transaction with enhanced population
    const transaction = await Transaction.findById(transactionId)
      .populate('userId', 'firstName lastName email')
      .populate('participants.userId', 'firstName lastName email')
      .select('+selectedUserType');

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Check transaction status
    if (!['funded', 'completed'].includes(transaction.status)) {
      return res.status(400).json({ error: 'Only funded or completed transactions can be disputed' });
    }

    // ENHANCED: Check for existing dispute (any dispute on this transaction)
    const existingDispute = await Dispute.findOne({ transactionId });
    if (existingDispute) {
      return res.status(400).json({
        error: 'A dispute already exists for this transaction',
        disputeId: existingDispute._id
      });
    }

    // ENHANCED: Check if user is part of the transaction (creator OR participant)
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p =>
      p.userId && p.userId._id.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      console.log('Unauthorized dispute creation attempt:', {
        userId,
        transactionCreator: transaction.userId._id.toString(),
        participants: transaction.participants.map(p => p.userId?._id?.toString())
      });
      return res.status(403).json({ error: 'Unauthorized to dispute this transaction' });
    }

    console.log('Dispute creation authorized:', {
      userId,
      isCreator,
      isParticipant,
      userRole: getUserRoleInTransaction(userId, transaction)
    });

    // Upload evidence to Cloudinary
    const evidence = [];
    for (const file of files) {
      const uploadImage = (buffer) => new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream({
          folder: 'dispute_evidence',
          allowed_formats: ['jpg', 'png', 'pdf'],
          public_id: `evidence_${userId}_${uuidv4()}`,
        }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
        uploadStream.end(buffer);
      });

      const result = await uploadImage(file.buffer);
      evidence.push({ url: result.secure_url, publicId: result.public_id });
    }

    // Create dispute
    const dispute = new Dispute({
      transactionId,
      userId,
      reason,
      description,
      evidence,
      status: 'Open',
    });

    const savedDispute = await dispute.save();
    console.log('Dispute saved successfully:', {
      disputeId: savedDispute._id,
      transactionId,
      userId,
      status: savedDispute.status,
      createdAt: savedDispute.createdAt,
    });

    // ENHANCED: Get ALL involved parties for notifications (including role info)
    const involvedUsers = [
      {
        id: transaction.userId._id.toString(),
        role: transaction.selectedUserType === 'buyer' ? 'Buyer' : 'Seller',
        isCreator: true
      },
      ...transaction.participants.map(p => ({
        id: p.userId._id.toString(),
        role: p.role ? p.role.charAt(0).toUpperCase() + p.role.slice(1) : 'Participant',
        isParticipant: true
      }))
    ].filter((user, index, self) =>
      self.findIndex(u => u.id === user.id) === index // Remove duplicates
    );

    // Create notifications for all involved parties
    const notifications = [];
    const disputeCreatorRole = getUserRoleInTransaction(userId, transaction);

    for (const user of involvedUsers) {
      if (user.id === userId) {
        // Notify dispute creator
        notifications.push({
          userId: user.id,
          title: 'Dispute Filed',
          message: `You filed a dispute for transaction ${transaction.reference || transaction._id}. Reason: ${reason}`,
        });
      } else {
        // Notify other party with role information
        notifications.push({
          userId: user.id,
          title: 'New Dispute Filed',
          message: `A dispute has been filed by ${disputeCreatorRole} for transaction ${transaction.reference || transaction._id}. Reason: ${reason}`,
        });
      }
    }

    // Notify admin if configured
    if (process.env.ADMIN_USER_ID) {
      notifications.push({
        userId: process.env.ADMIN_USER_ID,
        title: 'New Dispute Filed',
        message: `A dispute has been filed by ${disputeCreatorRole} for transaction ${transaction.reference || transaction._id}. Reason: ${reason}`,
      });
    }

    await Notification.insertMany(notifications);

    const io = req.app.get('io');
    notifications.forEach(({ userId }) => {
      io.to(`user_${userId}`).emit('disputeCreated', { disputeId: savedDispute._id });
    });

    // Send email notification to admin
    try {
      const userRole = getUserRoleInTransaction(userId, transaction);
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL || 'admin@example.com',
        subject: 'New Dispute Filed',
        text: `A new dispute has been filed by ${userRole} (${userId}) for transaction ${transaction.reference || transaction._id}. Reason: ${reason}.`,
      };
      await transporter.sendMail(mailOptions);
      console.log('Email notification sent to admin:', mailOptions.to);
    } catch (emailError) {
      console.error('Failed to send email notification:', {
        error: emailError.message,
        stack: emailError.stack,
      });
    }

    res.status(201).json({ success: true, data: { dispute: savedDispute } });
  } catch (error) {
    console.error('Error creating dispute:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to create dispute', details: error.message });
  }
};

exports.getUserDisputes = async (req, res) => {
  try {
    const { id: userId } = req.user;

    console.log('Fetching disputes for user:', userId);

    // Find all transactions where user is involved (creator or participant)
    const userTransactions = await Transaction.find({
      $or: [
        { userId: new mongoose.Types.ObjectId(userId) },
        { 'participants.userId': new mongoose.Types.ObjectId(userId) }
      ]
    }).select('_id');

    const transactionIds = userTransactions.map(t => t._id);
    console.log('Found user transactions:', transactionIds.length);

    // FIXED: Find ALL disputes for these transactions (not just user-created ones)
    const disputes = await Dispute.find({
      transactionId: { $in: transactionIds }
    })
      .populate({
        path: 'transactionId',
        select: 'reference paymentAmount productDetails status userId participants selectedUserType',
        populate: [
          { path: 'userId', select: 'firstName lastName email' },
          { path: 'participants.userId', select: 'firstName lastName email' }
        ]
      })
      .populate('userId', 'firstName lastName email')
      .sort({ createdAt: -1 });

    console.log('Found disputes (including participant disputes):', disputes.length);

    // Enhanced dispute data with role information
    const enhancedDisputes = disputes.map(dispute => {
      const disputeObj = dispute.toObject();
      const transaction = disputeObj.transactionId;

      // Add role information for better UI display
      if (transaction) {
        disputeObj.userRole = getUserRoleInTransaction(userId, transaction);
        disputeObj.isCreatedByMe = disputeObj.userId._id.toString() === userId;
      }

      return disputeObj;
    });

    res.status(200).json({
      success: true,
      data: { disputes: enhancedDisputes || [] }
    });

  } catch (error) {
    console.error('Error fetching disputes:', {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to fetch disputes',
      details: error.message
    });
  }
};

exports.getDisputeDetails = async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { id: userId, isAdmin } = req.user;

    console.log('Getting dispute details:', { disputeId, userId, isAdmin });

    const dispute = await Dispute.findById(disputeId)
      .populate({
        path: 'transactionId',
        select: 'reference paymentAmount productDetails status userId participants selectedUserType',
        populate: [
          { path: 'userId', select: 'firstName lastName email' },
          { path: 'participants.userId', select: 'firstName lastName email' }
        ]
      })
      .populate('userId', 'firstName lastName email');

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    // ENHANCED: Authorization check - allow ALL transaction participants AND admins
    const transaction = dispute.transactionId;
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p =>
      p.userId && p.userId._id.toString() === userId
    );

    // FIXED: Check if user is admin by querying the database to be sure
    let userIsAdmin = isAdmin;
    if (!userIsAdmin) {
      const user = await User.findById(userId).select('isAdmin');
      userIsAdmin = user?.isAdmin || false;
    }

    // Allow dispute creator, transaction creator, transaction participants, AND admins
    const hasAccess = isCreator || isParticipant || userIsAdmin || dispute.userId._id.toString() === userId;

    if (!hasAccess) {
      console.log('Access denied:', {
        userId,
        isCreator,
        isParticipant,
        isAdmin: userIsAdmin,
        disputeCreator: dispute.userId._id.toString()
      });
      return res.status(403).json({ error: 'Unauthorized to view this dispute' });
    }

    console.log('Access granted:', { userId, hasAccess, isCreator, isParticipant, isAdmin: userIsAdmin });

    // Get messages with enhanced user details including role
    const messages = await DisputeMessage.find({ disputeId })
      .populate('userId', 'firstName lastName isAdmin')
      .sort({ timestamp: 1 });

    // ENHANCED: Enhance messages with accurate user roles
    const enhancedMessages = messages.map(msg => {
      const messageObj = msg.toObject();

      if (messageObj.userId.isAdmin) {
        messageObj.userRole = 'Admin';
      } else {
        messageObj.userRole = getUserRoleInTransaction(messageObj.userId._id, transaction);
      }

      console.log('Message role assignment:', {
        messageUserId: messageObj.userId._id,
        assignedRole: messageObj.userRole,
        isAdmin: messageObj.userId.isAdmin
      });

      return messageObj;
    });

    res.status(200).json({
      success: true,
      data: {
        dispute,
        messages: enhancedMessages,
        currentUserRole: userIsAdmin ? 'Admin' : getUserRoleInTransaction(userId, transaction)
      }
    });
  } catch (error) {
    console.error('Error fetching dispute details:', error);
    res.status(500).json({ error: 'Failed to fetch dispute details', details: error.message });
  }
};


exports.sendDisputeMessage = async (req, res) => {
  try {
    const { message } = req.body;
    const { disputeId } = req.params;
    const { id: userId, isAdmin } = req.user;

    console.log("📨 RECEIVED MESSAGE REQUEST:", {
      disputeId,
      userId,
      isAdmin,
      messageLength: message?.length,
      timestamp: new Date().toISOString()
    });

    const dispute = await Dispute.findById(disputeId)
      .populate({
        path: 'transactionId',
        select: 'userId participants selectedUserType',
        populate: [
          { path: 'userId', select: '_id firstName lastName' },
          { path: 'participants.userId', select: '_id firstName lastName' }
        ]
      });

    if (!dispute) {
      console.log("❌ DISPUTE NOT FOUND:", disputeId);
      return res.status(404).json({ error: 'Dispute not found' });
    }

    // ENHANCED: Authorization check - allow ALL transaction participants AND admins
    const transaction = dispute.transactionId;
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p =>
      p.userId && p.userId._id.toString() === userId
    );
    const isDisputeCreator = dispute.userId._id.toString() === userId;

    // FIXED: Double-check admin status from database if needed
    let userIsAdmin = isAdmin;
    if (!userIsAdmin) {
      const user = await User.findById(userId).select('isAdmin');
      userIsAdmin = user?.isAdmin || false;
    }

    // Allow transaction creator, transaction participants, dispute creator, AND admins
    const canSendMessage = isCreator || isParticipant || isDisputeCreator || userIsAdmin;

    if (!canSendMessage) {
      console.log("❌ UNAUTHORIZED MESSAGE ATTEMPT:", {
        userId,
        disputeId,
        isCreator,
        isParticipant,
        isAdmin: userIsAdmin,
        disputeCreator: dispute.userId._id.toString()
      });
      return res.status(403).json({ error: 'Unauthorized to message in this dispute' });
    }

    console.log("✅ MESSAGE AUTHORIZATION PASSED:", {
      userId,
      canSendMessage,
      isCreator,
      isParticipant,
      isAdmin: userIsAdmin
    });

    // Save message to database
    const disputeMessage = new DisputeMessage({
      disputeId,
      userId,
      message,
    });

    const savedMessage = await disputeMessage.save();

    console.log("✅ MESSAGE SAVED TO DATABASE:", {
      messageId: savedMessage._id,
      disputeId,
      userId,
      timestamp: new Date().toISOString()
    });

    // Fetch user details for broadcast
    const user = await User.findById(userId).select('firstName lastName isAdmin');

    // ENHANCED: Determine accurate user role
    let userRole = 'Unknown';
    if (user.isAdmin || userIsAdmin) {
      userRole = 'Admin';
    } else {
      userRole = getUserRoleInTransaction(userId, transaction);
    }

    console.log("👤 USER ROLE DETERMINED:", {
      userId,
      userRole,
      isAdmin: user.isAdmin || userIsAdmin,
      transactionCreator: transaction.userId._id.toString(),
      transactionSelectedType: transaction.selectedUserType
    });

    // FIXED: Structure the broadcast message properly
    const broadcastMessage = {
      _id: savedMessage._id,
      disputeId,
      userId: {
        _id: userId,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdmin: user.isAdmin || userIsAdmin
      },
      userRole,
      message: savedMessage.message,
      timestamp: savedMessage.timestamp,
    };

    // Broadcast via socket to all users in the dispute room
    const io = req.app.get('io');
    io.to(`dispute_${disputeId}`).emit('disputeMessage', broadcastMessage);

    console.log("📡 MESSAGE BROADCASTED VIA SOCKET:", {
      messageId: savedMessage._id,
      room: `dispute_${disputeId}`,
      fromUser: user.firstName,
      userRole,
      timestamp: new Date().toISOString()
    });

    // FIXED: Send clean response back to sender
    res.status(201).json({
      success: true,
      data: {
        _id: savedMessage._id,
        disputeId,
        userId: {
          _id: userId,
          firstName: user.firstName,
          lastName: user.lastName,
          isAdmin: user.isAdmin || userIsAdmin
        },
        userRole,
        message: savedMessage.message,
        timestamp: savedMessage.timestamp
      }
    });

    console.log("✅ RESPONSE SENT TO SENDER:", {
      messageId: savedMessage._id,
      userId,
      userRole,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ ERROR SENDING DISPUTE MESSAGE:", {
      disputeId: req.params.disputeId,
      userId: req.user?.id,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
};

exports.cancelDispute = async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { id: userId } = req.user;

    const dispute = await Dispute.findById(disputeId)
      .populate({
        path: 'transactionId',
        select: '+selectedUserType', // Ensure selectedUserType is included
        populate: [
          { path: 'userId', select: '_id firstName lastName' },
          { path: 'participants.userId', select: '_id firstName lastName' }
        ]
      });

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    // Allow dispute creator or any transaction participant to cancel
    const transaction = dispute.transactionId;
    const isCreator = transaction.userId._id.toString() === userId;
    const isParticipant = transaction.participants.some(p =>
      p.userId && p.userId._id.toString() === userId
    );

    if (!isCreator && !isParticipant) {
      return res.status(403).json({ error: 'Unauthorized to cancel this dispute' });
    }

    // Only allow cancellation of open disputes
    if (dispute.status !== 'Open') {
      return res.status(400).json({ error: 'Only open disputes can be cancelled' });
    }

    dispute.status = 'Cancelled';
    await dispute.save();

    // Notify all involved parties
    const involvedUsers = [
      { id: transaction.userId._id.toString(), role: 'Seller' },
      ...transaction.participants.map(p => ({
        id: p.userId._id.toString(),
        role: 'Buyer'
      }))
    ].filter((user, index, self) =>
      self.findIndex(u => u.id === user.id) === index
    );

    const notifications = [];
    const cancellerRole = getUserRoleInTransaction(userId, transaction);

    for (const user of involvedUsers) {
      if (user.id === userId) {
        notifications.push({
          userId: user.id,
          title: 'Dispute Cancelled',
          message: `You cancelled the dispute for transaction ${transaction.reference || transaction._id}.`,
        });
      } else {
        notifications.push({
          userId: user.id,
          title: 'Dispute Cancelled',
          message: `The dispute for transaction ${transaction.reference || transaction._id} has been cancelled by the ${cancellerRole}.`,
        });
      }
    }

    if (process.env.ADMIN_USER_ID) {
      notifications.push({
        userId: process.env.ADMIN_USER_ID,
        title: 'Dispute Cancelled',
        message: `${cancellerRole} (${userId}) cancelled the dispute for transaction ${transaction.reference || transaction._id}.`,
      });
    }

    await Notification.insertMany(notifications);

    const io = req.app.get('io');
    notifications.forEach(({ userId }) => {
      io.to(`user_${userId}`).emit('disputeStatusUpdate', { disputeId, status: 'Cancelled' });
    });

    // Send email to admin
    try {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL || 'admin@example.com',
        subject: 'Dispute Cancelled',
        text: `The dispute ${disputeId} for transaction ${transaction.reference || transaction._id} has been cancelled by ${cancellerRole} (${userId}).`,
      };
      await transporter.sendMail(mailOptions);
    } catch (emailError) {
      console.error('Failed to send email notification:', emailError);
    }

    res.status(200).json({ success: true, message: 'Dispute cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling dispute:', error);
    res.status(500).json({ error: 'Failed to cancel dispute', details: error.message });
  }
};

// Admin: View all disputes
exports.getAllDisputes = async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: Admin access required' });
    }

    const disputes = await Dispute.find()
      .populate({
        path: 'transactionId',
        select: 'reference paymentAmount productDetails status userId participants selectedUserType',
        populate: [
          { path: 'userId', select: 'firstName lastName email' },
          { path: 'participants.userId', select: 'firstName lastName email' }
        ]
      })
      .populate('userId', 'firstName lastName email')
      .populate('assignedModerator', 'firstName lastName')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: { disputes } });
  } catch (error) {
    console.error('Error fetching all disputes:', error);
    res.status(500).json({ error: 'Failed to fetch disputes', details: error.message });
  }
};

// Admin: Update dispute status
exports.updateDisputeStatus = async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: Admin access required' });
    }

    const { disputeId } = req.params;
    const { status, assignedModerator } = req.body;

    const dispute = await Dispute.findById(disputeId)
      .populate({
        path: 'transactionId',
        populate: [
          { path: 'userId', select: '_id' },
          { path: 'participants.userId', select: '_id' }
        ]
      });

    if (!dispute) {
      return res.status(404).json({ error: 'Dispute not found' });
    }

    dispute.status = status || dispute.status;
    if (assignedModerator) {
      dispute.assignedModerator = assignedModerator;
    }

    await dispute.save();

    // Notify all involved parties
    const transaction = dispute.transactionId;
    const involvedUsers = [
      transaction.userId._id.toString(),
      ...transaction.participants.map(p => p.userId._id.toString())
    ].filter((userId, index, self) => self.indexOf(userId) === index);

    const notifications = involvedUsers.map(userId => ({
      userId,
      title: `Dispute ${status}`,
      message: `The dispute for transaction ${transaction.reference || transaction._id} is now ${status}.`,
    }));

    await Notification.insertMany(notifications);

    const io = req.app.get('io');
    involvedUsers.forEach(userId => {
      io.to(`user_${userId}`).emit('disputeStatusUpdate', { disputeId, status });
    });

    // Send email notifications to involved users
    try {
      const users = await User.find({ _id: { $in: involvedUsers } });
      for (const user of users) {
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: user.email,
          subject: `Dispute Status Update: ${status}`,
          text: `Your dispute for transaction ${transaction.reference || transaction._id} is now ${status}.`,
        };
        await transporter.sendMail(mailOptions);
      }
    } catch (emailError) {
      console.error('Failed to send email notifications:', emailError);
    }

    res.status(200).json({ success: true, data: { dispute } });
  } catch (error) {
    console.error('Error updating dispute status:', error);
    res.status(500).json({ error: 'Failed to update dispute status', details: error.message });
  }
};

exports.debugAllDisputes = async (req, res) => {
  try {
    const disputes = await Dispute.find()
      .populate('transactionId', 'reference')
      .populate('userId', 'firstName lastName email');
    console.log('All disputes in database:', disputes);
    res.status(200).json({ success: true, data: { disputes } });
  } catch (error) {
    console.error('Error fetching all disputes for debug:', error);
    res.status(500).json({ error: 'Failed to fetch disputes', details: error.message });
  }
};

// Check if a dispute exists for a transaction
exports.checkDisputeExists = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { id: userId } = req.user;

    console.log('Checking dispute for:', { transactionId, userId });

    // Check if any dispute exists for this transaction (not just user-created ones)
    const existingDispute = await Dispute.findOne({ transactionId });
    res.status(200).json({
      success: true,
      data: {
        hasDispute: !!existingDispute,
        disputeId: existingDispute?._id || null,
      },
    });
  } catch (error) {
    console.error('Error checking dispute:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to check dispute', details: error.message });
  }
};