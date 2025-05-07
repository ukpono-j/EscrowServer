const cron = require('node-cron');
const walletController = require('./controllers/walletController');

// Run every 10 minutes
// cron.schedule('*/10 * * * *', async () => {
//   console.log('Checking pending transactions via cron...');
//   try {
//     await walletController.reconcileTransactions();
//     console.log('Cron: Transaction reconciliation completed');
//   } catch (error) {
//     console.error('Cron: Reconciliation error:', {
//       message: error.message,
//       stack: error.stack,
//     });
//   }
// });

console.log('Cron job scheduled for pending transaction reconciliation');