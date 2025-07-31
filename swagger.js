const swaggerAutogen = require('swagger-autogen')();

const doc = {
    info: {
        version: '1.0.0',
        title: 'Sylo API',
        description: 'API documentation for the Sylo application',
    },
    host: 'localhost:3001', // Update with your server’s host and port (matches your PORT)
    basePath: '/api',
    schemes: ['http', 'https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    securityDefinitions: {
        bearerAuth: {
            type: 'apiKey',
            name: 'Authorization',
            in: 'header',
            description: 'JWT Authorization header using the Bearer scheme. Example: "Bearer {token}"'
        }
    }
};

const outputFile = './swagger-output.json';
const endpointsFiles = [
    './index.js',
    './routes/authRoutes.js',
    './routes/userRoutes.js',
    './routes/transactionRoutes.js',
    './routes/notificationRoutes.js',
    './routes/kycRoutes.js',
    './routes/walletRoutes.js',
    './routes/messages.js',
    './routes/adminRoutes.js'
];

swaggerAutogen(outputFile, endpointsFiles, doc);