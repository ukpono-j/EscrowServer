const crypto = require('crypto');
const { getPaystackSecretKey } = require('../controllers/walletController'); // Import helper

module.exports = (req, res, next) => {
  try {
    const secret = getPaystackSecretKey();
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Invalid Paystack webhook signature', {
        computedHash: hash,
        receivedSignature: req.headers['x-paystack-signature'],
      });
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }

    next();
  } catch (error) {
    console.error('Signature verification error:', {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};