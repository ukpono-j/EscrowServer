const express = require("express");
const { submitKYC, getKYCDetails } = require("../controllers/kycController");
const authenticateUser = require("../middlewares/authenticateUser");

const router = express.Router();

router.post("/submit-kyc", authenticateUser, submitKYC);
router.get("/kyc-details", authenticateUser, getKYCDetails);

module.exports = router;