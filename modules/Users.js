const mongoose = require("mongoose")

const UserSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    password: String,
    email:String
})


const UserModel = mongoose.model("users", UserSchema)
module.exports = UserModel



