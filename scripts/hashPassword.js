const bcrypt = require('bcrypt');
const saltRounds = 10;
const password = 'sylopays@@';
bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) console.error(err);
  console.log(hash);
});