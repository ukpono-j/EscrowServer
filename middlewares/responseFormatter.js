const responseFormatter = (req, res, next) => {
  const originalJson = res.json;

  res.json = function (data) {
    // Skip wrapping for /api/avatar or GET /api/messages with array data
    if (
      req.path.startsWith('/api/avatar') ||
      (req.path.startsWith('/api/messages') && req.method === 'GET' && Array.isArray(data))
    ) {
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

    // Handle success responses, preserving original spread behavior
    return originalJson.call(this, {
      success: true,
      ...data,
    });
  };

  next();
};

module.exports = responseFormatter;
