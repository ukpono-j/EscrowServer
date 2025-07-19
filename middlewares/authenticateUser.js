const jwt = require('jsonwebtoken');

function authenticateUser(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('access-token');

  if (!token) {
    console.warn('No token provided in request headers', {
      url: req.originalUrl,
      method: req.method,
    });
    return res.status(401).json({ success: false, error: 'Access denied: No token provided' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    const currentTimestamp = Math.floor(Date.now() / 1000);

    if (verified.exp && currentTimestamp > verified.exp) {
      console.warn('Token has expired', { userId: verified.id });
      return res.status(401).json({ success: false, error: 'Token has expired', tokenExpired: true });
    }

    if (!verified.id) {
      console.error('Token missing userId', { token });
      return res.status(401).json({ success: false, error: 'Invalid token: Missing userId' });
    }

    req.user = { id: verified.id }; // Simplified to only include userId
    next();
  } catch (error) {
    console.error('Token verification failed:', {
      message: error.message,
      url: req.originalUrl,
      method: req.method,
    });
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

module.exports = authenticateUser;