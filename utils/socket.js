const emitBalanceUpdate = (userId, data) => {
  const io = global.io; // Access Socket.IO instance set in app
  if (io) {
    io.to(userId.toString()).emit('balanceUpdate', {
      balance: data.balance,
      reference: data.reference,
      transaction: {
        amount: data.transaction.amount,
        reference: data.transaction.reference,
        status: data.transaction.status,
        type: data.transaction.type,
        createdAt: data.transaction.createdAt instanceof Date
          ? data.transaction.createdAt.toISOString()
          : data.transaction.createdAt,
        metadata: data.transaction.metadata,
      },
    });
    console.log('Balance update emitted via socket:', {
      userId,
      reference: data.reference,
      balance: data.balance,
    });
  } else {
    console.warn('Socket.IO instance not available for balance update', { userId });
  }
};

module.exports = { emitBalanceUpdate };