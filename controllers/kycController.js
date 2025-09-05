const KYC = require("../modules/Kyc");
const Notification = require("../modules/Notification");
const axios = require("axios");

const submitKYC = async (req, res) => {
  try {
    const { bvn } = req.body;
    const userId = req.user.id;

    // Validate BVN
    if (!bvn || !/^\d{11}$/.test(bvn)) {
      return res.status(400).json({ error: "Valid 11-digit BVN is required" });
    }

    // Check if KYC already exists
    const existingKYC = await KYC.findOne({ user: userId });
    if (existingKYC && existingKYC.status !== "rejected") {
      return res.status(400).json({ error: "BVN verification already submitted and not rejected" });
    }

    let verificationData;

    // Check for mock verification
    if (process.env.ENABLE_MOCK_VERIFICATION === "true") {
      console.log("Using mock verification for BVN:", bvn);
      verificationData = {
        firstName: "Test",
        lastName: "User",
        dateOfBirth: "1990-01-01",
        status: bvn === "12345678901" ? "VERIFIED" : "NOT_VERIFIED", // Mock success for specific BVN
      };
    } else {
      // Call YouVerify API for BVN verification
      console.log("Sending BVN verification request to YouVerify:", { bvn, userId });
      const youVerifyResponse = await axios.post(
        "https://api.sandbox.youverify.co/v2/api/identity/ng/bvn",
        { id: bvn, isSubjectConsent: true },
        {
          headers: {
            Authorization: `Bearer ${process.env.YOUVERIFY_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("YouVerify response:", youVerifyResponse.data);

      if (!youVerifyResponse.data.success) {
        return res.status(400).json({ 
          success: false, 
          error: youVerifyResponse.data.message || "BVN verification failed" 
        });
      }

      verificationData = youVerifyResponse.data.data || {};
      if (!verificationData.firstName || !verificationData.lastName || !verificationData.status) {
        return res.status(400).json({ 
          success: false, 
          error: "Incomplete verification data from YouVerify" 
        });
      }
    }

    // Save KYC data
    const newKYC = new KYC({
      user: userId,
      bvn,
      verificationResult: {
        firstName: verificationData.firstName || "",
        lastName: verificationData.lastName || "",
        dateOfBirth: verificationData.dateOfBirth ? new Date(verificationData.dateOfBirth) : null,
        status: verificationData.status === "VERIFIED" ? "VERIFIED" : "NOT_VERIFIED",
      },
      status: verificationData.status === "VERIFIED" ? "approved" : "rejected",
      isSubmitted: true,
    });

    await newKYC.save();
    console.log("KYC saved successfully:", { userId, bvn, status: newKYC.status });

    // Create notification
    const notification = new Notification({
      userId,
      title: "BVN Verification",
      message: `Your BVN verification has been ${newKYC.status}.`,
      status: "pending",
      type: "kyc",
      timestamp: new Date(),
      isRead: false,
    });
    await notification.save();
    console.log("Notification created:", { userId, message: notification.message });

    res.status(201).json({ 
      success: true, 
      message: "BVN verification submitted successfully", 
      status: newKYC.status 
    });
  } catch (error) {
    console.error("Error submitting KYC:", error.message, { 
      stack: error.stack,
      bvn: req.body.bvn,
      userId: req.user.id,
      apiResponse: error.response?.data 
    });
    res.status(500).json({ 
      success: false, 
      error: error.message || "Internal Server Error",
      details: error.response?.data || error.message 
    });
  }
};

const getKYCDetails = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log("Fetching KYC details for user:", userId);
    const kycDetails = await KYC.findOne({ user: userId }).select(
      "bvn verificationResult status isSubmitted createdAt updatedAt"
    );

    if (!kycDetails) {
      console.log("No KYC details found for user:", userId);
      return res.status(404).json({ 
        success: false, 
        error: "KYC details not found", 
        isKycSubmitted: false 
      });
    }

    res.status(200).json({
      success: true,
      kycDetails: {
        bvn: kycDetails.bvn,
        verificationResult: kycDetails.verificationResult,
        status: kycDetails.status,
        isSubmitted: kycDetails.isSubmitted,
        createdAt: kycDetails.createdAt,
        updatedAt: kycDetails.updatedAt,
      },
      isKycSubmitted: kycDetails.isSubmitted,
    });
  } catch (error) {
    console.error("Error fetching KYC details:", error.message, { 
      stack: error.stack,
      userId: req.user.id 
    });
    res.status(500).json({ 
      success: false, 
      error: "Internal Server Error", 
      isKycSubmitted: false 
    });
  }
};

// Note: uploadFiles endpoint is retained but not used for KYC
const uploadFiles = async (req, res) => {
  try {
    const upload = req.app.get("upload"); // Get multer instance
    upload.fields([
      { name: "documentPhoto", maxCount: 1 },
      { name: "personalPhoto", maxCount: 1 },
    ])(req, res, async (err) => {
      if (err) {
        console.error("Multer error:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      if (!req.files?.documentPhoto || !req.files?.personalPhoto) {
        return res.status(400).json({ success: false, error: "Both documentPhoto and personalPhoto are required" });
      }

      try {
        const cloudinary = require('cloudinary').v2;
        // Upload documentPhoto to Cloudinary
        const documentPhotoResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "kyc_documents", resource_type: "image" },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(req.files.documentPhoto[0].buffer);
        });

        // Upload personalPhoto to Cloudinary
        const personalPhotoResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "kyc_photos", resource_type: "image" },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(req.files.personalPhoto[0].buffer);
        });

        res.status(200).json({
          success: true,
          documentPhotoPath: documentPhotoResult.secure_url,
          personalPhotoPath: personalPhotoResult.secure_url,
        });
      } catch (cloudinaryError) {
        console.error("Cloudinary upload error:", cloudinaryError.message);
        res.status(500).json({ success: false, error: "Failed to upload files to Cloudinary" });
      }
    });
  } catch (error) {
    console.error("Error uploading files:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

module.exports = { submitKYC, getKYCDetails, uploadFiles };