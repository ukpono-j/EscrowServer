const express = require("express");
const { submitKYC, getKYCDetails, uploadFiles } = require("../controllers/kycController");
const authenticateUser = require("../middlewares/authenticateUser");

const router = express.Router();

router.post("/submit-kyc", authenticateUser, submitKYC);
router.get("/kyc-details", authenticateUser, getKYCDetails);
router.post("/upload", authenticateUser, uploadFiles); // Changed from GET to POST

module.exports = router;