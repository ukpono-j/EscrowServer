const KYC = require("../modules/KYC");
const Notification = require("../modules/Notification");
const path = require("path");

const submitKYC = async (req, res) => {
  try {
    const { documentType, documentPhotoPath, personalPhotoPath, firstName, lastName, dateOfBirth } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!documentType || !firstName || !lastName || !dateOfBirth || !documentPhotoPath || !personalPhotoPath) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validate documentType
    if (!["Drivers License", "NIN Slip", "Passport"].includes(documentType)) {
      return res.status(400).json({ error: "Invalid document type" });
    }

    // Validate dateOfBirth
    const dobDate = new Date(dateOfBirth);
    if (isNaN(dobDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format for dateOfBirth" });
    }

    // Validate age (must be at least 18)
    const today = new Date();
    let age = today.getFullYear() - dobDate.getFullYear();
    const monthDiff = today.getMonth() - dobDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
      age--;
    }
    if (age < 18) {
      return res.status(400).json({ error: "User must be at least 18 years old" });
    }

    // Validate file paths (ensure they start with /uploads/)
    const pathRegex = /^\/uploads\/.+/;
    if (!pathRegex.test(documentPhotoPath) || !pathRegex.test(personalPhotoPath)) {
      return res.status(400).json({ error: "Invalid photo paths. Must be valid server paths" });
    }

    // Check if KYC already exists
    const existingKYC = await KYC.findOne({ user: userId });
    if (existingKYC && existingKYC.status !== "rejected") {
      return res.status(400).json({ error: "KYC already submitted and not rejected" });
    }

    // Save KYC data
    const newKYC = new KYC({
      user: userId,
      documentType,
      documentPhoto: documentPhotoPath,
      personalPhoto: personalPhotoPath,
      firstName,
      lastName,
      dateOfBirth: dobDate,
      status: "pending",
      isSubmitted: true,
    });

    await newKYC.save();

    // Create notification
    const notification = new Notification({
      userId,
      title: "KYC Submission",
      message: "Your KYC documents have been submitted and are under review.",
      status: "pending",
      type: "kyc",
      timestamp: new Date(),
      isRead: false,
    });
    await notification.save();

    res.status(201).json({ success: true, message: "KYC submitted successfully" });
  } catch (error) {
    console.error("Error submitting KYC:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

const getKYCDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    const kycDetails = await KYC.findOne({ user: userId }).select(
      "documentType documentPhoto personalPhoto firstName lastName dateOfBirth status isSubmitted createdAt updatedAt"
    );

    if (!kycDetails) {
      return res.status(404).json({ success: false, error: "KYC details not found", isKycSubmitted: false });
    }

    res.status(200).json({
      success: true,
      kycDetails: {
        documentType: kycDetails.documentType,
        documentPhoto: kycDetails.documentPhoto,
        personalPhoto: kycDetails.personalPhoto,
        firstName: kycDetails.firstName,
        lastName: kycDetails.lastName,
        dateOfBirth: kycDetails.dateOfBirth,
        status: kycDetails.status,
        isSubmitted: kycDetails.isSubmitted,
        createdAt: kycDetails.createdAt,
        updatedAt: kycDetails.updatedAt,
      },
      isKycSubmitted: kycDetails.isSubmitted,
    });
  } catch (error) {
    console.error("Error fetching KYC details:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error", isKycSubmitted: false });
  }
};

// New endpoint for file uploads
const uploadFiles = async (req, res) => {
  try {
    const upload = req.app.get("upload"); // Get multer instance
    upload.fields([
      { name: "documentPhoto", maxCount: 1 },
      { name: "personalPhoto", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        console.error("Multer error:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      if (!req.files?.documentPhoto || !req.files?.personalPhoto) {
        return res.status(400).json({ success: false, error: "Both documentPhoto and personalPhoto are required" });
      }

      const documentPhotoPath = `/uploads/${req.files.documentPhoto[0].filename}`;
      const personalPhotoPath = `/uploads/${req.files.personalPhoto[0].filename}`;

      res.status(200).json({
        success: true,
        documentPhotoPath,
        personalPhotoPath,
      });
    });
  } catch (error) {
    console.error("Error uploading files:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

module.exports = { submitKYC, getKYCDetails, uploadFiles };