require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer-Cloudinary storage configuration
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'Escrow Media', // Specify a folder name in your Cloudinary account
    format: async (req, file) => 'png', // You can specify the format (e.g., jpg, png)
    public_id: (req, file) => file.originalname,
  },
});

const upload = multer({ storage: storage });

module.exports = upload;
