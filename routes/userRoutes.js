const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authenticateUser = require('../middlewares/authenticateUser');
const upload = require('../middlewares/upload');
const { setAvatar } = require('../controllers/userController');


router.get('/user-details', authenticateUser, userController.getUserDetails);
router.get('/all-user-details', authenticateUser, userController.getAllUserDetails);
router.put('/update-user-details', authenticateUser, userController.updateUserDetails);
router.post('/setAvatar', authenticateUser, upload.single('image'), setAvatar);


module.exports = router;
