// utils/VerifyPaystackSignature.js
const crypto = require("crypto");

module.exports = function(req, res, next) {
    try {
        const signature = req.headers["x-paystack-signature"];
        if (!signature) {
            console.log("No Paystack signature found in headers");
            return res.status(400).send("No signature");
        }

        // Convert request body to string if it's not already
        const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        
        // Create hash using your secret
        const secret = process.env.PAYSTACK_SECRET;
        const hash = crypto.createHmac("sha512", secret)
                          .update(body)
                          .digest("hex");
        
        console.log("Received signature:", signature);
        console.log("Computed hash:", hash);
        
        if (signature !== hash) {
            console.log("Invalid signature");
            return res.status(400).send("Invalid signature");
        }
        
        // If we get here, parse the body as JSON if needed
        if (typeof req.body === 'string') {
            req.body = JSON.parse(req.body);
        }
        
        console.log("Signature verified successfully");
        next();
    } catch (error) {
        console.error("Signature verification error:", error);
        res.status(400).send("Invalid payload");
    }
};