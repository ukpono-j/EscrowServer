const multer = require('multer');
const path = require('path');
const fs = require('fs'); 

// Multer storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../', 'uploads/images')); // Destination folder for uploaded files
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    // cb(null, uniqueSuffix + path.extname(file.originalname)); // Unique filename
    cb(null, file.originalname);
  }
});

// File filter function (optional)
const fileFilter = (req, file, cb) => {
  // Check file type, size, etc.
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
    cb(null, true); // Accept file
  } else {
    cb(new Error('Invalid file type. Only JPEG and PNG files are allowed.'), false); // Reject file
  }
};

// Multer instance with configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 5 // 5MB file size limit (optional)
  }
});

module.exports = upload;
