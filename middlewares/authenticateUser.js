const jwt = require('jsonwebtoken');
const pino = require('pino');

const logger = pino({ level: 'info' });

function authenticateUser(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('access-token');

  if (!token) {
    logger.error('No token provided in request headers', {
      url: req.originalUrl,
      method: req.method,
      headers: { authorization: req.header('Authorization'), accessToken: req.header('access-token') },
    });
    return res.status(401).json({ success: false, error: 'Access denied: No token provided' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    const currentTimestamp = Math.floor(Date.now() / 1000);

    if (!verified.id) {
      logger.error('Token missing userId', { token: token.slice(0, 10) + '...', url: req.originalUrl });
      return res.status(401).json({ success: false, error: 'Invalid token: Missing userId' });
    }

    if (verified.exp && currentTimestamp > verified.exp) {
      logger.warn('Token has expired', { userId: verified.id, url: req.originalUrl });
      return res.status(401).json({ success: false, error: 'Token has expired', tokenExpired: true });
    }

    req.user = { id: verified.id };
    logger.info('Token verified successfully', { userId: verified.id, url: req.originalUrl });
    next();
  } catch (error) {
    logger.error('Token verification failed', {
      message: error.message,
      url: req.originalUrl,
      method: req.method,
      errorName: error.name,
      token: token.slice(0, 10) + '...',
    });
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, error: 'Invalid token: Malformed or tampered' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token has expired', tokenExpired: true });
    }
    return res.status(401).json({ success: false, error: 'Authentication failed: Invalid token' });
  }
}

module.exports = authenticateUser;