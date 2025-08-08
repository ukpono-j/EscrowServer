// notificationService.js

const Notification = require('../modules/Notification');
const Transaction = require('../modules/Transactions');

/**
 * Notification service to handle creating notifications for different transaction events
 */
const notificationService = {
  /**
   * Create a notification when a transaction status changes
   * @param {Object} transaction - The transaction object
   * @param {String} status - The new status of the transaction
   * @param {Object} user - The user object (contains userId)
   * @returns {Promise<Object>} The created notification
   */
  async createTransactionStatusNotification(transaction, status, userId) {
    try {
      let title = '';
      let message = '';

      // Generate appropriate title and message based on status
      switch (status) {
        case 'completed':
          title = 'Transaction Completed';
          message = `Your transaction for ${transaction.paymentDescription} has been completed successfully.`;
          break;
        case 'canceled':
          title = 'Transaction Canceled';
          message = `Your transaction for ${transaction.paymentDescription} has been canceled.`;
          break;
        case 'active':
          title = 'Transaction Activated';
          message = `Your transaction for ${transaction.paymentDescription} is now active.`;
          break;
        default:
          title = 'Transaction Status Update';
          message = `Your transaction for ${transaction.paymentDescription} status changed to ${status}.`;
      }

      // Create notification for the transaction owner
      const ownerNotification = new Notification({
        userId: transaction.userId,
        title,
        message,
        transactionId: transaction.transactionId,
        type: 'transaction',
        status: 'pending',  // Notifications start as pending
      });

      await ownerNotification.save();

      // Create notifications for all participants
      if (transaction.participants && transaction.participants.length > 0) {
        const participantNotifications = transaction.participants.map(participant => {
          // Skip creating duplicate notification for the transaction owner
          if (participant.toString() === transaction.userId.toString()) {
            return null;
          }

          return new Notification({
            userId: participant,
            title,
            message,
            transactionId: transaction.transactionId,
            type: 'transaction',
            status: 'pending',
          });
        }).filter(notification => notification !== null);

        // Save all participant notifications if there are any
        if (participantNotifications.length > 0) {
          await Notification.insertMany(participantNotifications);
        }
      }

      return ownerNotification;
    } catch (error) {
      console.error('Error creating transaction status notification:', error);
      throw error;
    }
  },

  /**
   * Create notification when waybill details are uploaded
   * @param {Object} transaction - The transaction object
   * @returns {Promise<Object>} The created notification
   */
  async createWaybillUploadedNotification(transaction) {
    try {
      const title = 'Waybill Details Uploaded';
      const message = `Waybill details for your transaction "${transaction.paymentDescription}" have been uploaded.`;

      // Create notification for transaction owner
      const notification = new Notification({
        userId: transaction.userId,
        title,
        message,
        transactionId: transaction.transactionId,
        type: 'waybill',
        status: 'pending',
      });

      await notification.save();

      // Create notifications for participants if needed
      if (transaction.participants && transaction.participants.length > 0) {
        const participantNotifications = transaction.participants.map(participant => {
          // Skip if participant is the transaction owner
          if (participant.toString() === transaction.userId.toString()) {
            return null;
          }

          return new Notification({
            userId: participant,
            title,
            message,
            transactionId: transaction.transactionId,
            type: 'waybill',
            status: 'pending',
          });
        }).filter(notification => notification !== null);

        if (participantNotifications.length > 0) {
          await Notification.insertMany(participantNotifications);
        }
      }

      return notification;
    } catch (error) {
      console.error('Error creating waybill notification:', error);
      throw error;
    }
  },

  /**
   * Create notification when account is funded
   * @param {Object} transaction - The transaction object
   * @returns {Promise<Object>} The created notification
   */
  async createAccountFundedNotification(transaction) {
    try {
      const title = 'Account Funded';
      const message = `Your account has been funded with $${transaction.paymentAmount.toFixed(2)} for transaction "${transaction.paymentDescription}".`;

      const notification = new Notification({
        userId: transaction.userId,
        title,
        message,
        transactionId: transaction.transactionId,
        type: 'funding',
        status: 'pending',
      });

      await notification.save();
      return notification;
    } catch (error) {
      console.error('Error creating account funded notification:', error);
      throw error;
    }
  },

  /**
   * Create notification when buyer confirms receipt
   * @param {Object} transaction - The transaction object
   * @returns {Promise<Object>} The created notification
   */
  async createBuyerConfirmedNotification(transaction) {
    try {
      const title = 'Buyer Confirmed Receipt';
      const message = `Buyer has confirmed receipt for transaction "${transaction.paymentDescription}".`;

      // Create notification for the seller (transaction owner)
      const notification = new Notification({
        userId: transaction.userId,
        title,
        message,
        transactionId: transaction.transactionId,
        type: 'confirmation',
        status: 'pending',
      });

      await notification.save();
      return notification;
    } catch (error) {
      console.error('Error creating buyer confirmation notification:', error);
      throw error;
    }
  },

  /**
   * Create notification when seller confirms shipment
   * @param {Object} transaction - The transaction object
   * @returns {Promise<Object>} The created notification
   */
  async createSellerConfirmedNotification(transaction) {
    try {
      const title = 'Seller Confirmed Shipment';
      const message = `Seller has confirmed shipment for transaction "${transaction.paymentDescription}".`;

      // Find the buyer in participants
      const buyerParticipants = transaction.participants.filter(
        participant => participant.toString() !== transaction.userId.toString()
      );

      // Create notifications for buyer(s)
      if (buyerParticipants.length > 0) {
        const buyerNotifications = buyerParticipants.map(buyerId => {
          return new Notification({
            userId: buyerId,
            title,
            message,
            transactionId: transaction.transactionId,
            type: 'confirmation',
            status: 'pending',
          });
        });

        await Notification.insertMany(buyerNotifications);
        return buyerNotifications;
      }
      
      return null;
    } catch (error) {
      console.error('Error creating seller confirmation notification:', error);
      throw error;
    }
  },

  /**
   * Create notification when payment is released
   * @param {Object} transaction - The transaction object
   * @returns {Promise<Object>} The created notification
   */
  async createPaymentReleasedNotification(transaction) {
    try {
      const title = 'Payment Released';
      const message = `Payment of $${transaction.paymentAmount.toFixed(2)} for transaction "${transaction.paymentDescription}" has been released.`;

      // Create notification for transaction owner (seller)
      const notification = new Notification({
        userId: transaction.userId,
        title,
        message,
        transactionId: transaction.transactionId,
        type: 'payment',
        status: 'pending',
      });

      await notification.save();
      return notification;
    } catch (error) {
      console.error('Error creating payment released notification:', error);
      throw error;
    }
  }
};

module.exports = notificationService;