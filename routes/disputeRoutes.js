const express = require('express');
const router = express.Router();
const disputeController = require('../controllers/disputeController');
const authenticateUser = require('../middlewares/authenticateUser');
const authorizeAdmin = require('../middlewares/authorizeAdmin'); // Add this import
const upload = require('../middlewares/upload');

// User routes
router.post('/create', authenticateUser, upload.array('evidence', 5), disputeController.createDispute);
router.get('/my-disputes', authenticateUser, disputeController.getUserDisputes);
router.get('/:disputeId', authenticateUser, disputeController.getDisputeDetails);
router.post('/:disputeId/messages', authenticateUser, disputeController.sendDisputeMessage);
router.put('/:disputeId/cancel', authenticateUser, disputeController.cancelDispute);
router.get('/check/:transactionId', authenticateUser, disputeController.checkDisputeExists);

// Admin routes - Use authorizeAdmin instead of authenticateUser
router.get('/admin/all', authorizeAdmin, disputeController.getAllDisputes);
router.put('/admin/:disputeId/status', authorizeAdmin, disputeController.updateDisputeStatus);

// Debug route (remove in production)
router.get('/debug/all', disputeController.debugAllDisputes);

module.exports = router;