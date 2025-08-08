const jwt = require('jsonwebtoken');

const authorizeAdmin = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn('No valid token provided in Authorization header');
      return res.status(401).json({ error: 'Access Denied: No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;

    if (!decoded.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('AuthorizeAdmin error:', {
      message: error.message,
      name: error.name,
    });
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token has expired', tokenExpired: true });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = authorizeAdmin;