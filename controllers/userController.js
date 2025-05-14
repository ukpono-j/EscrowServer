const UserModel = require('../modules/Users');

exports.getUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const user = await UserModel.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const userWithAvatar = {
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
    };
    res.status(200).json(userWithAvatar);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getAllUserDetails = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const users = await UserModel.find({ _id: { $ne: userId } }).select(['email', 'firstName', '_id', 'avatarSeed']);
    if (!users || users.length === 0) {
      return res.status(404).json({ error: "No other users found" });
    }
    const usersWithAvatars = users.map(user => ({
      ...user.toObject(),
      avatarImage: `/api/avatar/${user.avatarSeed || user._id}`,
    }));
    res.status(200).json(usersWithAvatars);
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
    const avatarIdentifier = user.avatarSeed || user._id;
    const userWithAvatar = {
      ...user.toObject(),
      avatarImage: `/api/avatar/${avatarIdentifier}`,
    };
    res.status(200).json({ message: "User details updated successfully!", user: userWithAvatar });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};