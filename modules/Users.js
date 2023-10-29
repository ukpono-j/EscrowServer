const mongoose = require("mongoose")

const UserSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    password: String,
    email:String,
    bank:String,
    accountNumber:String,
    dateOfBirth:String,
})


const UserModel = mongoose.model("users", UserSchema)
module.exports = UserModel



