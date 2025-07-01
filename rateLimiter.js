const Bottleneck = require('bottleneck');

  const limiter = new Bottleneck({
    minTime: 1000, // 1 second between requests
    maxConcurrent: 5, // Max 5 concurrent requests
  });

  module.exports = limiter;