const KYC = require('../modules/Kyc');

// Controller to handle KYC submission
const submitKYC = async (req, res) => {
  try {
    console.log("Submitting KYC...");

    const { documentType, firstName, lastName, dateOfBirth } = req.body;
    const { documentPhoto, personalPhoto } = req.files;

    console.log("Received form data and files:", req.body, req.files);

    // Ensure user ID is available (e.g., from authentication)
    const userId = req.user.id;

    // Validate required fields
    if (!documentType || !firstName || !lastName || !dateOfBirth) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validate dateOfBirth format before creating new Date object
    const dobDate = new Date(dateOfBirth);
    if (isNaN(dobDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format for dateOfBirth" });
    }

    // Ensure documentType is a valid enum value
    if (!['Drivers License', 'NIN Slip', 'Passport'].includes(documentType)) {
      return res.status(400).json({ error: "Invalid documentType provided" });
    }

    // Check if files are uploaded
    if (!documentPhoto || !personalPhoto) {
      return res.status(400).json({ error: "Both documentPhoto and personalPhoto are required" });
    }

    // Save KYC data to MongoDB
    const newKYC = new KYC({
      user: userId,
      documentType,
      documentPhoto: `uploads/images/${documentPhoto[0].filename}`,
      personalPhoto: `uploads/images/${personalPhoto[0].filename}`,
      firstName,
      lastName,
      dateOfBirth: dobDate,
      isSubmitted: true,
    });

    await newKYC.save();

    console.log("KYC data saved:", newKYC);

    res.status(201).json({ success: true, message: "KYC submitted successfully" });
  } catch (error) {
    console.error("Error submitting KYC:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Controller to fetch KYC details
const getKYCDetails = async (req, res) => {
  try {
    const userId = req.user.id;

    const kycDetails = await KYC.findOne({ user: userId });

    if (!kycDetails) {
      return res.status(404).json({ success: false, error: 'KYC details not found', isKycSubmitted: false });
    }

    res.status(200).json({ success: true, kycDetails, isKycSubmitted: true });
  } catch (error) {
    console.error('Error fetching KYC details:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', isKycSubmitted: false });
  }
};

module.exports = {
  submitKYC,
  getKYCDetails,
};
