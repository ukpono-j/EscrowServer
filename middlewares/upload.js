const multer = require('multer');


const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, "uploads/images");
    },
    filename: (req, file, cb) => {
      // cb(null, file.originalname)
    //   cb(null, Date.now() + path.extname(file.originalname));
    cb(null, `${Date.now()}-${file.originalname}`);
    },
  });
  
  const upload = multer({ storage: storage });

  module.exports = upload;