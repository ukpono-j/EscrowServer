const responseFormatter = (req, res, next) => {
  const originalJson = res.json;

  res.json = function (data) {
    // Skip wrapping for /api/avatar or GET /api/messages
    if (
      req.path.startsWith('/api/avatar') ||
      (req.path.startsWith('/api/messages') && req.method === 'GET')
    ) {
      // Ensure data is an array for GET /api/messages
      if (req.path.startsWith('/api/messages') && req.method === 'GET') {
        const responseData = Array.isArray(data)
          ? data
          : typeof data === 'object' && data !== null
            ? Object.values(data).filter(
                (item) => item && typeof item === 'object' && item._id && item.message
              )
            : [];
        return originalJson.call(this, responseData);
      }
      return originalJson.call(this, data);
    }

    // Handle error responses
    if (res.statusCode >= 400) {
      return originalJson.call(this, {
        success: false,
        error: data.error || data.message || 'An error occurred',
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