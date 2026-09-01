/**
 * Vercel Serverless Function Entry Point
 * This file imports the Express app from backend.js and exports it for Vercel
 */

// Load environment variables
require('dotenv').config();

// Import the Express app from backend
// Backend.js needs to export the app instead of starting the server
const app = require('../backend');

// Export for Vercel
module.exports = app;
