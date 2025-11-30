const User = require('../modules/Users');
const Transaction = require('../modules/Transactions');
const Dispute = require('../modules/Dispute');
const KYC = require('../modules/Kyc');
const Wallet = require('../modules/wallet');
const Notification = require('../modules/Notification');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const pino = require('pino')();
const moment = require('moment-timezone');

exports.getDashboardStats = async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const transactionCount = await Transaction.countDocuments();
    const disputeCount = await Dispute.countDocuments({ status: { $in: ['open', 'pending'] } });
    const pendingKYC = await KYC.countDocuments({ status: 'pending' });
    const totalTransactionAmount = await Transaction.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$paymentAmount' } } },
    ]);

    let pendingWithdrawals = 0;
    try {
      const withdrawalsResult = await Wallet.aggregate([
        { $unwind: '$withdrawalRequests' },
        { $match: { 'withdrawalRequests.status': 'pending' } },
        { $group: { _id: null, total: { $sum: '$withdrawalRequests.amount' } } },
      ]);
      pendingWithdrawals = withdrawalsResult[0]?.total || 0;
    } catch (walletError) {
      console.error('Error fetching pending withdrawals:', walletError);
    }

    res.status(200).json({
      success: true,
      data: {
        userCount,
        transactionCount,
        disputeCount,
        pendingKYC,
        totalTransactionAmount: totalTransactionAmount[0]?.total || 0,
        pendingWithdrawals,
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: error.message,
    });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    console.log('Admin fetching all users');
    const users = await User.find()
      .select('-password')
      .sort({ createdAt: -1 });

    if (!users || users.length === 0) {
      console.log('No users found');
      return res.status(200).json({ success: true, data: [] });
    }

    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || '',
      phoneNumber: user.phoneNumber || '',
      bank: user.bank || '',
      accountNumber: user.accountNumber || '',
      isAdmin: user.isAdmin || false,
      dateOfBirth: user.dateOfBirth || null,
      avatarSeed: user.avatarSeed || user._id,
      paystackCustomerCode: user.paystackCustomerCode || '',
      createdAt: user.createdAt || new Date(),
    }));

    res.status(200).json({ success: true, data: usersWithAvatars });
  } catch (error) {
    console.error('Error fetching users:', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getAllTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find()
      .populate({
        path: 'participants.userId',
        select: 'firstName lastName',
      })
      .populate({
        path: 'userId',
        select: 'firstName lastName',
      })
      .sort({ createdAt: -1 });

    transactions.forEach((t) => {
      if (!t.participants || t.participants.length !== 2) {
        console.warn(`Transaction ${t._id} has invalid participants count: ${t.participants?.length || 0}`);
      }
      if (!t.userId || !t.userId.firstName || !t.userId.lastName) {
        console.warn(`Transaction ${t._id} has invalid creator userId:`, t.userId);
      }
      t.participants.forEach(p => {
        if (!p.userId || !p.userId.firstName || !p.userId.lastName) {
          console.warn(`Transaction ${t._id} has invalid userId for ${p.role}:`, p.userId);
        }
      });
    });

    res.status(200).json({ success: true, data: { transactions } });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getAllDisputes = async (req, res) => {
  try {
    console.log('Admin fetching all disputes');
    const disputes = await Dispute.find()
      .populate({
        path: 'transactionId',
        populate: [
          { path: 'userId', select: 'firstName lastName' },
          { path: 'participants.userId', select: 'firstName lastName' },
        ],
      })
      .sort({ createdAt: -1 });

    disputes.forEach((d) => {
      if (!d.transactionId) {
        console.warn(`Dispute ${d._id} has invalid transactionId`);
      }
      if (!d.createdBy || !d.createdBy.firstName || !d.createdBy.lastName) {
        console.warn(`Dispute ${d._id} has invalid creator:`, d.createdBy);
      }
    });

    res.status(200).json({ success: true, data: { disputes } });
  } catch (error) {
    console.error('Error fetching disputes:', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getPendingKYC = async (req, res) => {
  try {
    const pendingKYC = await KYC.find({ status: 'pending' });
    res.status(200).json({ success: true, data: { pendingKYC } });
  } catch (error) {
    console.error('Error fetching pending KYC:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.getAllWithdrawals = async (req, res) => {
  try {
    console.log('Admin fetching all withdrawal requests');
    const wallets = await Wallet.find()
      .populate({
        path: 'userId',
        select: 'firstName lastName email',
        match: { _id: { $exists: true } },
      })
      .lean();

    const withdrawalRequests = await Promise.all(
      wallets.flatMap(async (wallet) => {
        if (!wallet.withdrawalRequests) {
          console.warn('Wallet skipped due to missing withdrawalRequests', {
            walletId: wallet._id,
            userId: wallet.userId ? wallet.userId._id : 'missing',
          });
          return [];
        }

        if (!wallet.userId || !wallet.userId._id) {
          console.warn('Invalid or missing userId for wallet', {
            walletId: wallet._id,
            userId: wallet.userId,
          });

          return Promise.all(
            wallet.withdrawalRequests.map(async (request) => {
              const [firstName, ...lastNameParts] = request.metadata.accountName.split(' ');
              const lastName = lastNameParts.join(' ');
              const user = await User.findOne({
                $or: [
                  { firstName, lastName },
                  { firstName: request.metadata.accountName },
                ],
              }).lean();

              return {
                ...request,
                userId: user ? user._id : null,
                userName: user ? `${user.firstName} ${user.lastName}` : request.metadata.accountName,
                userEmail: user ? user.email || '' : '',
              };
            })
          );
        }

        return wallet.withdrawalRequests.map(request => ({
          ...request,
          userId: wallet.userId._id,
          userName: `${wallet.userId.firstName || 'Unknown'} ${wallet.userId.lastName || 'User'}`,
          userEmail: wallet.userId.email || '',
        }));
      })
    ).then(results => results.flat());

    const sortedRequests = withdrawalRequests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    console.log('Withdrawal requests sent:', sortedRequests);
    res.status(200).json({
      success: true,
      data: sortedRequests,
    });
  } catch (error) {
    console.error('Error fetching withdrawal requests:', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
  }
};

exports.markWithdrawalAsPaid = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id } = req.params;

      pino.info('Processing withdrawal payment', { reference: id });

      // Find wallet with the withdrawal request
      const wallet = await Wallet.findOne({ 'withdrawalRequests.reference': id }).session(session);
      if (!wallet) {
        pino.error('Wallet not found for withdrawal reference', { reference: id });
        throw new Error('Withdrawal request not found');
      }

      // Find the specific withdrawal request
      const withdrawal = wallet.withdrawalRequests.find(w => w.reference === id);
      if (!withdrawal) {
        pino.error('Withdrawal request not found in wallet', { reference: id, walletId: wallet._id });
        throw new Error('Withdrawal request not found');
      }

      // Check if already paid
      if (withdrawal.status === 'paid') {
        pino.warn('Withdrawal already marked as paid', { reference: id, paidDate: withdrawal.metadata.paidDate });
        throw new Error('Withdrawal already marked as paid');
      }

      // Check if withdrawal is pending (only pending withdrawals can be paid)
      if (withdrawal.status !== 'pending') {
        pino.warn('Cannot pay non-pending withdrawal', { reference: id, status: withdrawal.status });
        throw new Error(`Cannot process withdrawal with status: ${withdrawal.status}. Only pending withdrawals can be paid.`);
      }

      pino.info('Withdrawal request details', {
        reference: withdrawal.reference,
        amount: withdrawal.amount,
        status: withdrawal.status,
        accountName: withdrawal.metadata.accountName,
        bankName: withdrawal.metadata.bankName,
        currentWalletBalance: wallet.balance,
      });

      // ✅ CRITICAL: Verify wallet has sufficient balance
      // Note: For pending withdrawals, the balance should NOT have been deducted yet
      if (wallet.balance < withdrawal.amount) {
        pino.error('Insufficient balance for withdrawal', {
          reference: id,
          walletBalance: wallet.balance,
          withdrawalAmount: withdrawal.amount,
          shortfall: withdrawal.amount - wallet.balance,
        });
        throw new Error(
          `Insufficient balance to process withdrawal. ` +
          `Current balance: ₦${wallet.balance.toFixed(2)}, ` +
          `Withdrawal amount: ₦${withdrawal.amount.toFixed(2)}. ` +
          `This withdrawal request should be rejected.`
        );
      }

      // ✅ Get balance details for logging
      const balanceDetails = wallet.getBalanceDetails();
      pino.info('Balance verification before payment', {
        totalBalance: wallet.balance,
        availableBalance: balanceDetails.availableBalance,
        pendingWithdrawals: balanceDetails.pendingWithdrawals,
        withdrawalAmount: withdrawal.amount,
      });

      // ✅ DEDUCT BALANCE NOW (money is being sent to customer's bank account)
      const previousBalance = wallet.balance;
      wallet.balance -= withdrawal.amount;

      // ✅ Update withdrawal status to 'paid'
      withdrawal.status = 'paid';
      withdrawal.metadata.paidDate = moment.tz('Africa/Lagos').toDate();
      withdrawal.metadata.approvedBy = req.user?.id || 'admin'; // Track who approved
      withdrawal.updatedAt = moment.tz('Africa/Lagos').toDate();

      // Mark the withdrawalRequests array as modified
      wallet.markModified('withdrawalRequests');
      await wallet.save({ session });

      pino.info('Withdrawal marked as paid successfully', {
        reference: withdrawal.reference,
        amount: withdrawal.amount,
        previousBalance,
        newBalance: wallet.balance,
        paidDate: withdrawal.metadata.paidDate,
      });

      // ✅ Create notification for customer
      await Notification.create(
        [
          {
            userId: wallet.userId,
            title: 'Withdrawal Processed',
            message: `Your withdrawal request of ₦${withdrawal.amount.toFixed(2)} to ${withdrawal.metadata.accountName} at ${withdrawal.metadata.bankName} has been approved and processed. Amount of ₦${withdrawal.amount.toFixed(2)} has been deducted from your wallet and sent to your bank account.`,
            reference: withdrawal.reference,
            type: 'withdrawal',
            status: 'completed',
            createdAt: moment.tz('Africa/Lagos').toDate(),
          },
        ],
        { session }
      );

      pino.info('Notification created for withdrawal payment', { userId: wallet.userId, reference: withdrawal.reference });

      // ✅ Emit real-time update via WebSocket
      const io = req.app.get('io');
      if (io) {
        io.to(wallet.userId.toString()).emit('withdrawalUpdate', {
          reference: withdrawal.reference,
          status: 'paid',
          amount: withdrawal.amount,
          paidDate: withdrawal.metadata.paidDate,
          newBalance: wallet.balance,
          availableBalance: wallet.getAvailableBalance(),
          message: `Withdrawal of ₦${withdrawal.amount.toFixed(2)} has been paid to your bank account.`,
        });
        pino.info('WebSocket event emitted', { userId: wallet.userId, reference: withdrawal.reference });
      } else {
        pino.warn('WebSocket instance not available', { reference: withdrawal.reference });
      }

      // ✅ Return success response
      res.status(200).json({
        success: true,
        message: 'Withdrawal request marked as paid and balance deducted. Money sent to customer\'s bank account.',
        data: {
          reference: withdrawal.reference,
          amount: withdrawal.amount,
          status: withdrawal.status,
          paidDate: withdrawal.metadata.paidDate,
          accountName: withdrawal.metadata.accountName,
          bankName: withdrawal.metadata.bankName,
          accountNumber: withdrawal.metadata.accountNumber?.slice(-4) || 'N/A',
          previousBalance: previousBalance,
          newBalance: wallet.balance,
          availableBalance: wallet.getAvailableBalance(),
          deductedAmount: withdrawal.amount,
        },
      });
    });
  } catch (error) {
    pino.error('Error marking withdrawal as paid', {
      reference: req.params.id,
      message: error.message,
      stack: error.stack,
      adminUser: req.user?.id,
    });

    // Determine appropriate status code
    let statusCode = 400;
    if (error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('Insufficient balance')) {
      statusCode = 400;
    } else if (error.message.includes('already marked as paid')) {
      statusCode = 409; // Conflict
    }

    res.status(statusCode).json({
      success: false,
      error: error.message,
    });
  } finally {
    await session.endSession();
  }
};

exports.adminLogin = async (req, res) => {
  const requestId = uuidv4();
  console.time(`Admin Login Process ${requestId}`);
  try {
    const { email, password } = req.body;

    console.log(`Admin login attempt for email: ${email}`);
    console.log(`Received password: ${password}`);

    if (!email || !password) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(400).json({ error: 'Email and password are required' });
    }

    console.time(`Find Admin ${requestId}`);
    const user = await User.findOne({ email, isAdmin: true }).select('+password');
    console.timeEnd(`Find Admin ${requestId}`);
    if (!user) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(404).json({ error: 'Admin user not found' });
    }

    console.time(`Compare Password ${requestId}`);
    const isMatch = await user.comparePassword(password);
    console.timeEnd(`Compare Password ${requestId}`);
    console.log(`Password comparison result: ${isMatch}`);
    if (!isMatch) {
      console.timeEnd(`Admin Login Process ${requestId}`);
      return res.status(401).json({ error: 'Invalid credentials', details: 'Password mismatch' });
    }

    console.time(`Generate Tokens ${requestId}`);
    const accessToken = jwt.sign({ id: user._id, isAdmin: user.isAdmin }, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.timeEnd(`Generate Tokens ${requestId}`);

    res.status(200).json({
      success: true,
      message: 'Admin login successful',
      accessToken,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isAdmin: user.isAdmin,
      },
    });
    console.timeEnd(`Admin Login Process ${requestId}`);
  } catch (error) {
    console.error('Admin login error:', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error', details: error.message });
    console.timeEnd(`Admin Login Process ${requestId}`);
  }
};


exports.rejectWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const { id } = req.params;
      const { reason } = req.body;

      const wallet = await Wallet.findOne({ 'withdrawalRequests.reference': id }).session(session);

      if (!wallet) {
        throw new Error('Withdrawal request not found');
      }

      const withdrawal = wallet.withdrawalRequests.find(w => w.reference === id);
      if (!withdrawal) {
        throw new Error('Withdrawal request not found');
      }
      if (withdrawal.status !== 'pending') {
        throw new Error(`Cannot reject withdrawal with status: ${withdrawal.status}`);
      }

      // Update status to failed (no balance deduction since it was never deducted)
      withdrawal.status = 'failed';
      withdrawal.metadata.rejectionReason = reason || 'Rejected by admin';
      withdrawal.metadata.rejectedDate = moment.tz('Africa/Lagos').toDate();
      withdrawal.updatedAt = moment.tz('Africa/Lagos').toDate();
      wallet.markModified('withdrawalRequests');
      await wallet.save({ session });

      await Notification.create(
        [
          {
            userId: wallet.userId,
            title: 'Withdrawal Request Rejected',
            message: `Your withdrawal request of ₦${withdrawal.amount.toFixed(2)} has been rejected. Reason: ${reason || 'Contact support for details'}. Your balance remains unchanged.`,
            reference: withdrawal.reference,
            type: 'withdrawal',
            status: 'failed',
            createdAt: moment.tz('Africa/Lagos').toDate(),
          },
        ],
        { session }
      );

      const io = req.app.get('io');
      if (io) {
        io.to(wallet.userId.toString()).emit('withdrawalUpdate', {
          reference: withdrawal.reference,
          status: 'failed',
          rejectedDate: withdrawal.metadata.rejectedDate,
          availableBalance: wallet.getAvailableBalance(),
        });
      }

      res.status(200).json({
        success: true,
        message: 'Withdrawal request rejected',
        data: {
          reference: withdrawal.reference,
          status: withdrawal.status,
          rejectedDate: withdrawal.metadata.rejectedDate,
          availableBalance: wallet.getAvailableBalance(),
        },
      });
    });
  } catch (error) {
    console.error('Error rejecting withdrawal:', { message: error.message, stack: error.stack });
    res.status(400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
};

exports.getCustomerFinancialSummary = async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const user = await User.findOne({ email }).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    const wallet = await Wallet.findOne({ userId: user._id }).lean();
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found for this customer' });
    }

    console.log('\n========================================');
    console.log(`FULL AUDIT TRAIL FOR: ${user.email}`);
    console.log('========================================\n');

    // ===== 1. WALLET TRANSACTIONS AUDIT =====
    const walletTxns = wallet.transactions || [];
    console.log(`📊 Total wallet transactions: ${walletTxns.length}`);

    // Direct deposits (Paystack top-ups ONLY - exclude payouts and refunds)
    const depositTransactions = walletTxns.filter(t =>
      t.type === 'deposit' &&
      t.status === 'completed' &&
      !t.reference?.includes('PAYOUT') &&
      !t.reference?.includes('REFUND') &&
      !t.metadata?.purpose?.includes('payout') &&
      !t.metadata?.purpose?.includes('Transaction payout') &&
      !t.metadata?.purpose?.includes('refund')
    );
    const totalDeposited = depositTransactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    console.log(`\n💰 DEPOSITS (Paystack Top-ups ONLY):`);
    console.log(`   Count: ${depositTransactions.length}`);
    console.log(`   Total: ₦${totalDeposited.toLocaleString()}`);

    // Wallet withdrawals (P2P funding)
    const walletWithdrawals = walletTxns.filter(t =>
      t.type === 'withdrawal' &&
      t.status === 'completed'
    );
    const totalWalletWithdrawals = walletWithdrawals.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    console.log(`\n💸 WALLET WITHDRAWALS (P2P funding - ACTUAL MONEY SPENT AS BUYER):`);
    console.log(`   Count: ${walletWithdrawals.length}`);
    console.log(`   Total: ₦${totalWalletWithdrawals.toLocaleString()}`);

    // Refunds
    const refunds = walletTxns.filter(t =>
      t.type === 'deposit' &&
      t.status === 'completed' &&
      (t.reference?.includes('REFUND') || t.metadata?.purpose?.includes('refund'))
    );
    const totalRefunds = refunds.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    console.log(`\n🔄 REFUNDS:`);
    console.log(`   Count: ${refunds.length}`);
    console.log(`   Total: ₦${totalRefunds.toLocaleString()}`);

    // Payouts received (as seller)
    const payouts = walletTxns.filter(t =>
      t.type === 'deposit' &&
      t.status === 'completed' &&
      (t.reference?.includes('PAYOUT') || t.metadata?.purpose?.includes('Transaction payout'))
    );
    const totalPayouts = payouts.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    console.log(`\n💵 PAYOUTS RECEIVED (as Seller from completed transactions):`);
    console.log(`   Count: ${payouts.length}`);
    console.log(`   Total: ₦${totalPayouts.toLocaleString()}`);

    // ===== 2. ALL TRANSACTIONS AUDIT (CRITICAL FOR LOCKED FUNDS) =====
    const allUserTransactions = await Transaction.find({
      $or: [
        { userId: user._id },
        { 'participants.userId': user._id }
      ]
    }).lean();

    console.log(`\n🤝 ALL P2P TRANSACTIONS: ${allUserTransactions.length}`);

    // ✅ COMPLETED transactions
    const completedTransactions = allUserTransactions.filter(t => t.status === 'completed');

    // Completed as SELLER
    const completedSellerTransactions = completedTransactions.filter(t => {
      const isCreatorSeller = t.userId.toString() === user._id.toString() && t.selectedUserType === 'seller';
      const isParticipantSeller = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'seller'
      );
      return isCreatorSeller || isParticipantSeller;
    });
    const totalEarnedAsSeller = completedSellerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n🛒 COMPLETED AS SELLER:`);
    console.log(`   Count: ${completedSellerTransactions.length}`);
    console.log(`   Total: ₦${totalEarnedAsSeller.toLocaleString()}`);

    // Completed as BUYER
    const completedBuyerTransactions = completedTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer'
      );
      return isCreatorBuyer || isParticipantBuyer;
    });
    const totalCompletedAsBuyer = completedBuyerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n💳 COMPLETED AS BUYER:`);
    console.log(`   Count: ${completedBuyerTransactions.length}`);
    console.log(`   Total: ₦${totalCompletedAsBuyer.toLocaleString()}`);

    // ✅ FUNDED TRANSACTIONS ONLY (ACTUAL LOCKED FUNDS - MONEY IN ESCROW)
    // CRITICAL FIX: Only "funded" status means money is locked. "pending" means not yet funded.
    const fundedTransactions = allUserTransactions.filter(t => t.status === 'funded');

    // Funded as BUYER (money locked in escrow)
    const fundedBuyerTransactions = fundedTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer'
      );
      return isCreatorBuyer || isParticipantBuyer;
    });
    const totalLockedAsBuyer = fundedBuyerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n🔒 FUNDED AS BUYER (Money Actually Locked in Escrow):`);
    console.log(`   Count: ${fundedBuyerTransactions.length}`);
    console.log(`   Total: ₦${totalLockedAsBuyer.toLocaleString()}`);
    fundedBuyerTransactions.forEach((t, i) => {
      console.log(`   ${i + 1}. ₦${t.paymentAmount.toLocaleString()} - Status: ${t.status} - ID: ${t._id}`);
    });

    // Funded as SELLER (awaiting delivery & payment)
    const fundedSellerTransactions = fundedTransactions.filter(t => {
      const isCreatorSeller = t.userId.toString() === user._id.toString() && t.selectedUserType === 'seller';
      const isParticipantSeller = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'seller'
      );
      return isCreatorSeller || isParticipantSeller;
    });
    const totalAwaitingAsSeller = fundedSellerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n⏳ FUNDED AS SELLER (Awaiting Delivery & Payout):`);
    console.log(`   Count: ${fundedSellerTransactions.length}`);
    console.log(`   Total: ₦${totalAwaitingAsSeller.toLocaleString()}`);
    fundedSellerTransactions.forEach((t, i) => {
      console.log(`   ${i + 1}. ₦${t.paymentAmount.toLocaleString()} - Status: ${t.status} - ID: ${t._id}`);
    });

    // ✅ PENDING TRANSACTIONS (NOT YET FUNDED - NO MONEY LOCKED)
    const pendingTransactions = allUserTransactions.filter(t => t.status === 'pending');

    const pendingBuyerTransactions = pendingTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer'
      );
      return isCreatorBuyer || isParticipantBuyer;
    });

    const pendingSellerTransactions = pendingTransactions.filter(t => {
      const isCreatorSeller = t.userId.toString() === user._id.toString() && t.selectedUserType === 'seller';
      const isParticipantSeller = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'seller'
      );
      return isCreatorSeller || isParticipantSeller;
    });

    console.log(`\n⏱️  PENDING TRANSACTIONS (Not Yet Funded - No Money Locked):`);
    console.log(`   As Buyer: ${pendingBuyerTransactions.length} transactions`);
    console.log(`   As Seller: ${pendingSellerTransactions.length} transactions`);

    // ✅ DISPUTED TRANSACTIONS
    const disputedTransactions = allUserTransactions.filter(t => t.status === 'disputed');

    // Disputed as BUYER
    const disputedBuyerTransactions = disputedTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer'
      );
      return isCreatorBuyer || isParticipantBuyer;
    });
    const totalDisputedAsBuyer = disputedBuyerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n⚠️  DISPUTED AS BUYER:`);
    console.log(`   Count: ${disputedBuyerTransactions.length}`);
    console.log(`   Total: ₦${totalDisputedAsBuyer.toLocaleString()}`);

    // Disputed as SELLER
    const disputedSellerTransactions = disputedTransactions.filter(t => {
      const isCreatorSeller = t.userId.toString() === user._id.toString() && t.selectedUserType === 'seller';
      const isParticipantSeller = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'seller'
      );
      return isCreatorSeller || isParticipantSeller;
    });
    const totalDisputedAsSeller = disputedSellerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n⚠️  DISPUTED AS SELLER:`);
    console.log(`   Count: ${disputedSellerTransactions.length}`);
    console.log(`   Total: ₦${totalDisputedAsSeller.toLocaleString()}`);

    // ✅ CANCELED/EXPIRED TRANSACTIONS
    const canceledTransactions = allUserTransactions.filter(t =>
      ['canceled', 'expired'].includes(t.status)
    );
    const canceledBuyerTransactions = canceledTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p =>
        p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer'
      );
      return isCreatorBuyer || isParticipantBuyer;
    });
    const totalCanceledAsBuyer = canceledBuyerTransactions.reduce((sum, t) => sum + (Number(t.paymentAmount) || 0), 0);

    console.log(`\n❌ CANCELED/EXPIRED AS BUYER:`);
    console.log(`   Count: ${canceledBuyerTransactions.length}`);
    console.log(`   Total: ₦${totalCanceledAsBuyer.toLocaleString()}`);

    // ===== 3. WITHDRAWAL REQUESTS AUDIT =====
    const allWithdrawals = wallet.withdrawalRequests || [];
    const paidWithdrawals = allWithdrawals.filter(w => w.status === 'paid');
    const totalWithdrawn = paidWithdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
    const pendingWithdrawals = allWithdrawals.filter(w => w.status === 'pending');
    const totalPendingWithdrawals = pendingWithdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
    const failedWithdrawals = allWithdrawals.filter(w => w.status === 'failed');
    const totalFailedWithdrawals = failedWithdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);

    console.log(`\n💰 WITHDRAWAL REQUESTS: ${allWithdrawals.length}`);
    console.log(`   Paid: ${paidWithdrawals.length} (₦${totalWithdrawn.toLocaleString()})`);
    console.log(`   Pending: ${pendingWithdrawals.length} (₦${totalPendingWithdrawals.toLocaleString()})`);
    console.log(`   Failed: ${failedWithdrawals.length} (₦${totalFailedWithdrawals.toLocaleString()})`);

    // ===== 4. BALANCE CALCULATION =====
    const currentBalance = Number(wallet.balance || 0);
    const availableBalance = currentBalance - totalPendingWithdrawals;

    console.log(`\n========================================`);
    console.log(`📊 COMPREHENSIVE BALANCE CALCULATION:`);
    console.log(`========================================`);
    console.log(`\n💰 MONEY IN:`);
    console.log(`   Deposits (Paystack):     +₦${totalDeposited.toLocaleString()}`);
    console.log(`   Payouts (as Seller):     +₦${totalPayouts.toLocaleString()}`);
    console.log(`   Refunds:                 +₦${totalRefunds.toLocaleString()}`);
    console.log(`   TOTAL IN:                 ₦${(totalDeposited + totalPayouts + totalRefunds).toLocaleString()}`);

    console.log(`\n💸 MONEY OUT:`);
    console.log(`   Wallet Withdrawals (P2P): -₦${totalWalletWithdrawals.toLocaleString()}`);
    console.log(`   Bank Withdrawals (paid):  -₦${totalWithdrawn.toLocaleString()}`);
    console.log(`   TOTAL OUT:                 ₦${(totalWalletWithdrawals + totalWithdrawn).toLocaleString()}`);

    console.log(`\n🔒 LOCKED IN FUNDED TRANSACTIONS ONLY:`);
    console.log(`   Funded Buyer (Escrow):    ₦${totalLockedAsBuyer.toLocaleString()} (${fundedBuyerTransactions.length} transactions)`);
    console.log(`   Disputed Buyer:           ₦${totalDisputedAsBuyer.toLocaleString()} (${disputedBuyerTransactions.length} transactions)`);
    console.log(`   Funded Seller (Awaiting): ₦${totalAwaitingAsSeller.toLocaleString()} (${fundedSellerTransactions.length} transactions)`);
    console.log(`   Disputed Seller:          ₦${totalDisputedAsSeller.toLocaleString()} (${disputedSellerTransactions.length} transactions)`);

    console.log(`\n🧮 THEORETICAL BALANCE:`);
    const theoreticalBalance = (totalDeposited + totalPayouts + totalRefunds) - (totalWalletWithdrawals + totalWithdrawn);
    console.log(`   = Money IN - Money OUT`);
    console.log(`   = ₦${theoreticalBalance.toLocaleString()}`);

    console.log(`\n💳 ACTUAL BALANCE:`);
    console.log(`   Current Balance:     ₦${currentBalance.toLocaleString()}`);
    console.log(`   Pending Withdrawals: -₦${totalPendingWithdrawals.toLocaleString()}`);
    console.log(`   Available Balance:    ₦${availableBalance.toLocaleString()}`);

    const balanceMismatch = currentBalance - theoreticalBalance;
    console.log(`\n⚠️  BALANCE VERIFICATION:`);
    console.log(`   Difference: ₦${balanceMismatch.toLocaleString()}`);
    if (Math.abs(balanceMismatch) < 1) {
      console.log(`   ✅ Balance matches!`);
    } else {
      console.log(`   ❌ Balance mismatch detected!`);
    }
    console.log(`========================================\n`);

    // Withdrawal validation
    const withdrawalsWithValidation = allWithdrawals.map(w => {
      const withdrawalDate = new Date(w.createdAt);
      const depositsBefore = depositTransactions.filter(t => new Date(t.createdAt) < withdrawalDate).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const payoutsBefore = payouts.filter(t => new Date(t.createdAt) < withdrawalDate).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const refundsBefore = refunds.filter(t => new Date(t.createdAt) < withdrawalDate).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const walletWithdrawalsBefore = walletWithdrawals.filter(t => new Date(t.createdAt) < withdrawalDate).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const withdrawnBefore = allWithdrawals.filter(wr => new Date(wr.createdAt) < withdrawalDate && wr.status === 'paid' && wr.reference !== w.reference).reduce((sum, wr) => sum + (Number(wr.amount) || 0), 0);
      const balanceAtRequest = depositsBefore + payoutsBefore + refundsBefore - walletWithdrawalsBefore - withdrawnBefore;
      const isValid = (Number(w.amount) || 0) <= balanceAtRequest;

      return {
        reference: w.reference,
        amount: Number(w.amount || 0),
        status: w.status,
        isValid,
        balanceAtRequestTime: Number(balanceAtRequest.toFixed(2)),
        breakdown: {
          deposits: Number(depositsBefore.toFixed(2)),
          receivedAsSeller: Number(payoutsBefore.toFixed(2)),
          paidAsBuyer: Number(walletWithdrawalsBefore.toFixed(2)),
          previousWithdrawals: Number(withdrawnBefore.toFixed(2))
        }
      };
    });

    // Count all transactions by role
    const allBuyerTransactions = allUserTransactions.filter(t => {
      const isCreatorBuyer = t.userId.toString() === user._id.toString() && t.selectedUserType === 'buyer';
      const isParticipantBuyer = t.participants?.some(p => p.userId && p.userId.toString() === user._id.toString() && p.role === 'buyer');
      return isCreatorBuyer || isParticipantBuyer;
    });

    const allSellerTransactions = allUserTransactions.filter(t => {
      const isCreatorSeller = t.userId.toString() === user._id.toString() && t.selectedUserType === 'seller';
      const isParticipantSeller = t.participants?.some(p => p.userId && p.userId.toString() === user._id.toString() && p.role === 'seller');
      return isCreatorSeller || isParticipantSeller;
    });

    // ✅ COMPREHENSIVE RESPONSE
    res.status(200).json({
      success: true,
      data: {
        user: {
          _id: user._id,
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          email: user.email,
          phoneNumber: user.phoneNumber || 'N/A',
          createdAt: user.createdAt,
          // ✅ FIXED: Return actual Cloudinary URL or null
          avatarImage: user.avatarImage || null,
        },
        financials: {
          // Money IN
          totalDeposited: Number(totalDeposited.toFixed(2)),
          totalPayoutsReceived: Number(totalPayouts.toFixed(2)),
          totalRefunds: Number(totalRefunds.toFixed(2)),

          // Money OUT  
          totalWalletWithdrawals: Number(totalWalletWithdrawals.toFixed(2)),
          totalWithdrawn: Number(totalWithdrawn.toFixed(2)),

          // P2P Activity - Completed
          totalEarnedAsSeller: Number(totalEarnedAsSeller.toFixed(2)),
          totalSpentAsBuyer: Number(totalWalletWithdrawals.toFixed(2)),
          totalCompletedAsBuyer: Number(totalCompletedAsBuyer.toFixed(2)),

          // 🔒 LOCKED FUNDS METRICS (FUNDED ONLY - ACTUAL LOCKED MONEY)
          lockedFunds: {
            // As Buyer (FUNDED transactions only)
            fundedBuyerAmount: Number(totalLockedAsBuyer.toFixed(2)),
            fundedBuyerCount: fundedBuyerTransactions.length,

            // Disputed
            disputedBuyerAmount: Number(totalDisputedAsBuyer.toFixed(2)),
            disputedBuyerCount: disputedBuyerTransactions.length,

            // As Seller (FUNDED transactions only)
            fundedSellerAmount: Number(totalAwaitingAsSeller.toFixed(2)),
            fundedSellerCount: fundedSellerTransactions.length,
            disputedSellerAmount: Number(totalDisputedAsSeller.toFixed(2)),
            disputedSellerCount: disputedSellerTransactions.length,

            // CRITICAL: Total actually locked (only funded + disputed)
            totalLockedAmount: Number((totalLockedAsBuyer + totalDisputedAsBuyer).toFixed(2)),
            totalAwaitingPayout: Number((totalAwaitingAsSeller + totalDisputedAsSeller).toFixed(2)),

            // Pending counts (NOT locked, just for info)
            pendingBuyerCount: pendingBuyerTransactions.length,
            pendingSellerCount: pendingSellerTransactions.length,
          },

          // Transaction counts
          completedBuyerTransactions: completedBuyerTransactions.length,
          completedSellerTransactions: completedSellerTransactions.length,
          totalBuyerTransactions: allBuyerTransactions.length,
          totalSellerTransactions: allSellerTransactions.length,

          // Pending/Failed Withdrawals
          totalAttemptedWithdrawals: Number(allWithdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0).toFixed(2)),
          totalPendingWithdrawals: Number(totalPendingWithdrawals.toFixed(2)),
          totalFailedWithdrawals: Number(totalFailedWithdrawals.toFixed(2)),

          // Balances
          currentBalance: Number(currentBalance.toFixed(2)),
          availableBalance: Number(availableBalance.toFixed(2)),
          theoreticalBalance: Number(theoreticalBalance.toFixed(2)),
          balanceMismatch: Number(balanceMismatch.toFixed(2)),

          // Withdrawal validation
          withdrawalsValidation: withdrawalsWithValidation,

          // Audit trails
          auditTrail: {
            deposits: depositTransactions.length,
            payouts: payouts.length,
            refunds: refunds.length,
            walletWithdrawals: walletWithdrawals.length,
            paidWithdrawals: paidWithdrawals.length,
            pendingWithdrawals: pendingWithdrawals.length,
            failedWithdrawals: failedWithdrawals.length,
            completedTransactions: completedTransactions.length,
            fundedTransactions: fundedTransactions.length,
            pendingTransactions: pendingTransactions.length,
            disputedTransactions: disputedTransactions.length,
            canceledTransactions: canceledTransactions.length,
          }
        },
        statsUpdatedAt: new Date()
      }
    });

  } catch (error) {
    console.error('Error fetching customer summary:', error);
    res.status(500).json({ success: false, error: 'Server error', details: error.message });
  }
};