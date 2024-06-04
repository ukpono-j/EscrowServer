const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const UserModel = require("../modules/Users");

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Received login request for email:", email);
    const user = await UserModel.findOne({ email: email });

    if (user && bcrypt.compareSync(password, user.password)) {
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
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
