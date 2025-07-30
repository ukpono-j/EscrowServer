const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateUser = require('../middlewares/authenticateUser');

router.get('/user-details', authenticateUser, userController.getUserDetails);
router.get('/all-user-details', authenticateUser, userController.getAllUserDetails);
router.put('/update-user-details', authenticateUser, userController.updateUserDetails);
router.get('/avatar/:seed', userController.getAvatar);

module.exports = router;