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
        first_name: "Test",
        last_name: "User",
        dob: "1990-01-01",
        status: bvn === "12345678901" ? "verified" : "not_verified", // Mock success for specific BVN
      };
    } else {
      // Use Paystack's Customer Validation API for BVN verification
      console.log("Sending BVN verification request to Paystack:", { bvn, userId });
      
      try {
        // Step 1: Create a temporary customer with BVN for validation
        const customerPayload = {
          email: `temp-${Date.now()}@verification.temp`,
          first_name: "Verification",
          last_name: "User",
          identification: {
            type: "bvn",
            number: bvn
          }
        };

        console.log("Creating customer for BVN validation:", customerPayload);

        const createCustomerResponse = await axios.post(
          "https://api.paystack.co/customer",
          customerPayload,
          {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 30000,
          }
        );

        console.log("Customer creation response:", createCustomerResponse.data);

        if (!createCustomerResponse.data.status) {
          throw new Error(createCustomerResponse.data.message || "Failed to create customer for verification");
        }

        const customerId = createCustomerResponse.data.data.id;

        // Step 2: Validate the customer's BVN
        const validationPayload = {
          type: "bvn",
          value: bvn,
          customer: customerId
        };

        console.log("Validating BVN:", validationPayload);

        const validationResponse = await axios.post(
          "https://api.paystack.co/customer/validate",
          validationPayload,
          {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
            timeout: 30000,
          }
        );

        console.log("Validation response:", validationResponse.data);

        if (!validationResponse.data.status) {
          return res.status(400).json({
            success: false,
            error: validationResponse.data.message || "BVN verification failed",
          });
        }

        // Extract verification data from the response
        const validationData = validationResponse.data.data;
        verificationData = {
          first_name: validationData.first_name || "Unknown",
          last_name: validationData.last_name || "Unknown", 
          dob: validationData.date_of_birth || null,
          status: validationData.verified ? "verified" : "not_verified",
        };

        // Cleanup: Delete the temporary customer
        try {
          await axios.delete(`https://api.paystack.co/customer/${customerId}`, {
            headers: {
              Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            },
          });
          console.log("Temporary customer cleaned up");
        } catch (cleanupError) {
          console.warn("Failed to cleanup temporary customer:", cleanupError.message);
          // Don't fail the main process for cleanup errors
        }

        if (!verificationData.first_name || !verificationData.last_name) {
          return res.status(400).json({
            success: false,
            error: "Incomplete verification data from Paystack",
          });
        }

      } catch (paystackError) {
        console.error("Paystack API error:", {
          message: paystackError.message,
          response: paystackError.response?.data,
          status: paystackError.response?.status,
          config: {
            url: paystackError.config?.url,
            method: paystackError.config?.method,
          }
        });

        // Handle specific error cases
        if (paystackError.response?.status === 404) {
          return res.status(400).json({
            success: false,
            error: "BVN verification service is currently unavailable. Please try again later.",
          });
        }

        if (paystackError.response?.status === 429) {
          return res.status(429).json({
            success: false,
            error: "Too many verification requests. Please try again later.",
          });
        }

        return res.status(400).json({
          success: false,
          error: paystackError.response?.data?.message || "Failed to verify BVN with Paystack",
        });
      }
    }

    // Save KYC data
    const newKYC = new KYC({
      user: userId,
      bvn,
      verificationResult: {
        firstName: verificationData.first_name || "",
        lastName: verificationData.last_name || "",
        dateOfBirth: verificationData.dob ? new Date(verificationData.dob) : null,
        status: verificationData.status === "verified" ? "VERIFIED" : "NOT_VERIFIED",
      },
      status: verificationData.status === "verified" ? "approved" : "rejected",
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
      status: newKYC.status,
    });
  } catch (error) {
    console.error("Error submitting KYC:", error.message, {
      stack: error.stack,
      bvn: req.body.bvn,
      userId: req.user.id,
      apiResponse: error.response?.data,
    });
    res.status(500).json({
      success: false,
      error: error.message || "Internal Server Error",
      details: error.response?.data || error.message,
    });
  }
};

const submitKYCWithYouVerify = async (req, res) => {
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
        first_name: "Test",
        last_name: "User",
        date_of_birth: "1990-01-01",
        status: bvn === "12345678901" ? "verified" : "not_verified",
      };
    } else {
      // Use YouVerify API for BVN verification
      console.log("Sending BVN verification request to YouVerify:", { bvn, userId });
      
      try {
        const youverifyResponse = await axios.post(
          "https://api.youverify.co/v2/api/identity/ng/bvn",
          {
            id: bvn,
          },
          {
            headers: {
              Token: process.env.YOUVERIFY_API_KEY,
              "Content-Type": "application/json",
            },
            timeout: 30000,
          }
        );

        console.log("YouVerify response:", youverifyResponse.data);

        if (!youverifyResponse.data.success) {
          return res.status(400).json({
            success: false,
            error: youverifyResponse.data.message || "BVN verification failed",
          });
        }

        const data = youverifyResponse.data.data;
        verificationData = {
          first_name: data.firstName || data.first_name,
          last_name: data.lastName || data.last_name,
          date_of_birth: data.dateOfBirth || data.date_of_birth,
          status: youverifyResponse.data.success ? "verified" : "not_verified",
        };

        if (!verificationData.first_name || !verificationData.last_name) {
          return res.status(400).json({
            success: false,
            error: "Incomplete verification data from YouVerify",
          });
        }

      } catch (youverifyError) {
        console.error("YouVerify API error:", {
          message: youverifyError.message,
          response: youverifyError.response?.data,
          status: youverifyError.response?.status,
        });

        return res.status(400).json({
          success: false,
          error: youverifyError.response?.data?.message || "Failed to verify BVN with YouVerify",
        });
      }
    }

    // Save KYC data
    const newKYC = new KYC({
      user: userId,
      bvn,
      verificationResult: {
        firstName: verificationData.first_name || "",
        lastName: verificationData.last_name || "",
        dateOfBirth: verificationData.date_of_birth ? new Date(verificationData.date_of_birth) : null,
        status: verificationData.status === "verified" ? "VERIFIED" : "NOT_VERIFIED",
      },
      status: verificationData.status === "verified" ? "approved" : "rejected",
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

    res.status(201).json({
      success: true,
      message: "BVN verification submitted successfully",
      status: newKYC.status,
    });
  } catch (error) {
    console.error("Error submitting KYC:", error.message, {
      stack: error.stack,
      bvn: req.body.bvn,
      userId: req.user.id,
    });
    res.status(500).json({
      success: false,
      error: error.message || "Internal Server Error",
    });
  }
};

// Keep getKYCDetails and uploadFiles unchanged
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
        isKycSubmitted: false,
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
      userId: req.user.id,
    });
    res.status(500).json({
      success: false,
      error: "Internal Server Error",
      isKycSubmitted: false,
    });
  }
};

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
        return res.status(400).json({
          success: false,
          error: "Both documentPhoto and personalPhoto are required",
        });
      }

      try {
        const cloudinary = require("cloudinary").v2;
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
        res.status(500).json({
          success: false,
          error: "Failed to upload files to Cloudinary",
        });
      }
    });
  } catch (error) {
    console.error("Error uploading files:", error.message);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

module.exports = { 
  submitKYC, 
  submitKYCWithYouVerify,
  getKYCDetails, 
  uploadFiles 
};