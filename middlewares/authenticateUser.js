const jwt = require("jsonwebtoken");

function authenticateUser(req, res, next) {
  let token = req.header("Authorization")?.replace("Bearer ", "") || req.header("access-token");
  if (!token) {
    console.warn("No token provided in request headers");
    return res.status(401).json({ error: "Access Denied" });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (verified.exp && currentTimestamp > verified.exp) {
      return res.status(401).json({ error: "Token has expired", tokenExpired: true });
    }
    req.user = verified;
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = authenticateUser;