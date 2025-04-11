const jwt = require("jsonwebtoken");
const User = require('../modules/Users');

// function authenticateUser(req, res, next) {
//   const token = req.header("auth-token");
//   console.log("Received Token:", token); // Add this line for logging
//   if (!token) return res.status(401).json({ error: "Access Denied" });

//   try {
//     const verified = jwt.verify(token, process.env.JWT_SECRET);

//     // Check if the token has expired
//     const currentTimestamp = Math.floor(Date.now() / 1000);
//     if (verified.exp && currentTimestamp > verified.exp) {
//       return res.status(401).json({ error: "Token has expired" });
//     }

//     console.log("Verified User:", verified);
//     req.user = verified;
//     next(); // Move to the next middleware
//   } catch (error) {
//     console.error(error); // Log the error for debugging
//     res.status(401).json({ error: "Invalid Token" });
//   }
// }

// module.exports = authenticateUser;
const authenticateUser = async (req, res, next) => {
  const token = req.header("auth-token");

  console.log("Received Token:", token); // Debug log

  if (!token) {
    return res.status(401).json({ error: "No authentication token provided" });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);

    // Check if the token has expired (optional — jwt.verify usually handles this)
    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (verified.exp && currentTimestamp > verified.exp) {
      return res.status(401).json({ error: "Token has expired" });
    }

    // Find the user by ID from the token payload
    const user = await User.findById(verified.id || verified._id);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    console.log("Authenticated User:", user.email || user._id);
    req.user = user;
    next(); // Continue to the next middleware or route handler
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = authenticateUser;
