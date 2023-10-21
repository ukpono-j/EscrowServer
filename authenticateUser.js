const jwt = require("jsonwebtoken");

function authenticateUser(req, res, next) {
  const token = req.header("auth-token");
  if (!token) return res.status(401).json({ error: "Access Denied" });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next(); // Move to the next middleware
  } catch (error) {
    res.status(401).json({ error: "Invalid Token" });
  }
}

module.exports = authenticateUser;
