const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 24 * 60 * 60 }); // Cache for 24 hours

module.exports = cache;