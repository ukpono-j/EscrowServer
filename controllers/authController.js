const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const UserModel = require("../modules/Users");
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// Create transporter for sending emails
let transporter;

// Initialize email transporter based on environment
if (process.env.NODE_ENV === 'production') {
  // Production email service (can be configured for any provider)
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    }
  });
} else {
  // For local development: use Ethereal (fake SMTP service)
  // The createTestAccount function will be called on first email send
  transporter = null;
}

// Create OTP Schema and Model for persistent storage
const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    index: true
  },
  otp: {
    type: String,
    required: true
  },
  userId: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    // Automatically delete expired OTPs (TTL index)
    expires: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create the model or use existing one to avoid duplicate model errors
const OTPModel = mongoose.models.OTP || mongoose.model('OTP', otpSchema);

// Generate a random 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Setup an Ethereal test account for local development (called once)
const setupEtherealAccount = async () => {
  try {
    // Create a test account on ethereal.email
    const testAccount = await nodemailer.createTestAccount();

    // Create reusable transporter using the test account
    const testTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
      // Add this to prevent connection timeouts
      connectionTimeout: 5000,
      greetingTimeout: 5000,
    });

    // console.log('Ethereal Email test account created:');
    // console.log(`- Email: ${testAccount.user}`);
    // console.log(`- Password: ${testAccount.pass}`);
    // console.log('View messages at: https://ethereal.email');

    return testTransporter;
  } catch (error) {
    console.error("Error creating Ethereal account:", error);
    // Fallback to a fake transport that just logs emails
    return {
      sendMail: (mailOptions) => {
        // console.log("EMAIL WOULD BE SENT IN PRODUCTION");
        // console.log("To:", mailOptions.to);
        // console.log("Subject:", mailOptions.subject);
        // console.log("OTP:", mailOptions.html.match(/\d{6}/)[0]);
        return Promise.resolve({ messageId: 'fake-message-id' });
      }
    };
  }
};


exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    // Find user by email
    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    // Generate OTP
    const otp = generateOTP();

    // Store OTP in database (remove any existing ones first)
    await OTPModel.deleteMany({ email });

    // Create new OTP document
    await OTPModel.create({
      email,
      otp,
      userId: user._id.toString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
    });

    // In development mode, skip actual email sending
    if (process.env.NODE_ENV !== 'production') {
      // console.log('=========================================');
      // console.log(`DEVELOPMENT MODE - Password Reset OTP for ${email}: ${otp}`);
      // console.log('=========================================');

      return res.status(200).json({
        success: true,
        message: "OTP generated successfully",
        devMode: true,
        devOtp: otp  // Include OTP in response for development
      });
    }

    // For production: Try to send email
    try {
      // Make sure transporter is set up for production
      if (!transporter) {
        // Initialize production transporter
        transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: process.env.EMAIL_PORT,
          secure: process.env.EMAIL_SECURE === 'true',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
          }
        });
      }

      // Prepare email with OTP
      const msg = {
        from: process.env.FROM_EMAIL || 'noreply@yourapplication.com',
        to: email,
        subject: 'Password Reset OTP',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #031420; text-align: center;">Password Reset Request</h2>
            <p>We received a request to reset your password. Use the following OTP code to reset your password:</p>
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0;">
              <h1 style="margin: 0; color: #B38939; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
            </div>
            <p>This code will expire in 15 minutes.</p>
            <p>If you didn't request a password reset, please ignore this email or contact support if you have concerns.</p>
            <p style="margin-top: 30px; font-size: 12px; color: #666; text-align: center;">This is an automated message, please do not reply.</p>
          </div>
        `
      };

      // Send email
      await transporter.sendMail(msg);

      res.status(200).json({
        success: true,
        message: "OTP sent to your email"
      });
    } catch (emailError) {
      console.error("Error sending email:", emailError);
      res.status(500).json({
        error: "Failed to send OTP email. Please try again later."
      });
    }
  } catch (error) {
    console.error("Error in forgotPassword:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// Verify OTP and reset password
exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    // Find OTP document for this email
    const otpDoc = await OTPModel.findOne({ email });

    // Check if OTP exists
    if (!otpDoc) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    // Check if OTP is valid
    if (otpDoc.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP. Please try again." });
    }

    // Check if OTP has expired
    if (new Date() > new Date(otpDoc.expiresAt)) {
      // Clean up expired OTP
      await OTPModel.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    // Get user ID from OTP document
    const userId = otpDoc.userId;

    // Hash the new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10);

    // Update user's password in the database
    const updatedUser = await UserModel.findByIdAndUpdate(
      userId,
      { password: hashedPassword },
      { new: true } // Return the updated document
    );

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found." });
    }

    // Remove OTP from database after successful password reset
    await OTPModel.deleteOne({ _id: otpDoc._id });

    // Return success response
    res.status(200).json({
      success: true,
      message: "Password reset successful"
    });
  } catch (error) {
    console.error("Error in resetPassword:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// exports.login = async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     // console.log("Received login request for email:", email);
//     const user = await UserModel.findOne({ email: email });

//     if (user && bcrypt.compareSync(password, user.password)) {
//       // Create a JWT with proper expiration (8 hours)
//       const token = jwt.sign(
//         { id: user._id },
//         process.env.JWT_SECRET,
//         { expiresIn: '8h' }  // Token expires in 8 hours
//       );

//       res.header("auth-token", token).json({ message: "Login successful!", token });
//     } else {
//       res.status(401).json({ error: "Invalid Credentials" });
//     }
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// };

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    // console.log("Received login request for email:", email);
    const user = await UserModel.findOne({ email: email });

    if (!user) {
      // If user doesn't exist, return 404 status
      return res.status(404).json({ error: "User not found" });
    }

    if (bcrypt.compareSync(password, user.password)) {
      // Create a JWT with longer expiration (7 days)
      const token = jwt.sign(
        { id: user._id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }  // Token expires in 7 days instead of 8 hours
      );

      res.header("auth-token", token).json({ message: "Login successful!", token });
    } else {
      res.status(401).json({ error: "Invalid Credentials" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};


exports.register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, bank, dateOfBirth, accountNumber } = req.body;

    const existingUser = await UserModel.findOne({ email: email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const newUser = new UserModel({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      bank,
      accountNumber,
      dateOfBirth,
    });

    await newUser.save();
    res.status(200).json({ message: "User registered successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};