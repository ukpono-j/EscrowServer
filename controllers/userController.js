const UserModel = require('../modules/Users');

exports.getUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getAllUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const users = await UserModel.find({ _id: { $ne: userId } }).select(['email', 'firstName', 'avatarImage', '_id']);

    if (!users || users.length === 0) {
      return res.status(404).json({ error: "No other users found" });
    }

    res.status(200).json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.updateUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { firstName, lastName, dateOfBirth, bank, accountNumber } = req.body;

    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.dateOfBirth = dateOfBirth || user.dateOfBirth;
    user.bank = bank || user.bank;
    user.accountNumber = accountNumber || user.accountNumber;

    await user.save();
    res.status(200).json({ message: "User details updated successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};



// exports.setAvatar = async (req, res) => {
//   // const { filename } = req.file; // Assuming Multer saves the file to 'uploads/images'


//   try {
//     const userId = req.user.id;
//      const imageUrl = req.file.path; 
//     const updatedUser = await UserModel.findByIdAndUpdate(
//       userId,
//       {
//         avatar: imageUrl 
//       },
//       { new: true }
//     );
//     console.log(updatedUser);
//     if (updatedUser) {
//       res.status(200).json({ success: true, user: updatedUser });
//     } else {
//       res.status(404).json({ success: false, error: "User not found" });
//     }
//   } catch (error) {
//     console.error("Error setting avatar:", error);
//     res.status(500).json({ success: false, error: "Internal Server Error" });
//   }
// };

// exports.setAvatar = async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const imageUrl = req.file.path; // Multer saves the file path in req.file.path

//     const updatedUser = await UserModel.findByIdAndUpdate(
//       userId,
//       { avatarImage: imageUrl }, // Update avatarImage field with the new image URL
//       { new: true }
//     );

//     if (!updatedUser) {
//       return res.status(404).json({ success: false, error: "User not found" });
//     }

//     res.status(200).json({ success: true, user: updatedUser });
//   } catch (error) {
//     console.error("Error setting avatar:", error);
//     res.status(500).json({ success: false, error: "Internal Server Error" });
//   }
// };

exports.setAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const imageUrl = req.file.originalname; 

    const updatedUser = await UserModel.findByIdAndUpdate(
      userId,
      { 
        avatarImage: imageUrl,
        isAvatarImageSet: true // Update isAvatarImageSet to true when avatarImage is set
      },
      { new: true }
    );

    if (updatedUser) {
      res.status(200).json({ success: true, user: updatedUser });
    } else {
      res.status(404).json({ success: false, error: "User not found" });
    }
  } catch (error) {
    console.error("Error setting avatar:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};