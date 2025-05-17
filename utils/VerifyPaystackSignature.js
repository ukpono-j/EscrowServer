const crypto = require('crypto');

module.exports = (req, res, next) => {
  try {
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) {
      console.error('PAYSTACK_SECRET is not defined');
      return res.status(500).json({ success: false, error: 'Server configuration error' });
    }

    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Invalid Paystack webhook signature');
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