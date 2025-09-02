const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png'];
    if (!validTypes.includes(file.mimetype)) {
      return cb(new Error('Only JPEG or PNG files are allowed'));
    }
    if (file.size > 5 * 1024 * 1024) {
      return cb(new Error('File size must be less than 5MB'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = upload;