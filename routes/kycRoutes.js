const express = require('express');
const { submitKYC, getKYCDetails } = require('../controllers/kycController');
const authenticateUser = require('../middlewares/authenticateUser');
const upload = require('./upload');

const router = express.Router();

router.post('/submit-kyc', authenticateUser, upload.fields([
  { name: 'documentPhoto', maxCount: 1 },
  { name: 'personalPhoto', maxCount: 1 },
]), submitKYC);

router.get('/kyc-details', authenticateUser, getKYCDetails);

module.exports = router;