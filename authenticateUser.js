const jwt = require("jsonwebtoken");

function authenticateUser(req, res, next) {
  const token = req.header("auth-token");
  console.log("Received Token:", token); // Add this line for logging
  if (!token) return res.status(401).json({ error: "Access Denied" });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    console.log("Verified User:", verified);
    req.user = verified;
    next(); // Move to the next middleware
  } catch (error) {
    console.error(error); // Log the error for debugging
    res.status(401).json({ error: "Invalid Token" });
  }
}

module.exports = authenticateUser;
