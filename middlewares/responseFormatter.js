const responseFormatter = (req, res, next) => {
    const originalJson = res.json;
  
    res.json = function (data) {
      // Skip for certain routes like /api/avatar
      if (req.path.startsWith('/api/avatar')) {
        return originalJson.call(this, data);
      }
  
      // Handle error responses
      if (res.statusCode >= 400) {
        return originalJson.call(this, {
          success: false,
          error: data.error || 'An error occurred',
          details: data.details || undefined,
        });
      }
  
      // Handle success responses
      return originalJson.call(this, {
        success: true,
        ...data,
      });
    };
  
    next();
  };
  
  module.exports = responseFormatter;