const KYC = require('../modules/Kyc');

const submitKYC = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      documentType,
      firstName,
      lastName,
      dateOfBirth,
    } = req.body;
    const documentPhoto = req.files['documentPhoto'][0].filename;
    const personalPhoto = req.files['personalPhoto'][0].filename;

    const kyc = new KYC({
      user: userId,
      documentType,
      documentPhoto,
      personalPhoto,
      firstName,
      lastName,
      dateOfBirth,
      isSubmitted: true,
    });

    await kyc.save();

    res.status(201).json({ success: true, message: "KYC submitted successfully" });
  } catch (error) {
    console.error("Error submitting KYC:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

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
