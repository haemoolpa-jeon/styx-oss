// Environment configuration and validation
const path = require('path');

/**
 * Server configuration object
 * @type {Object}
 * @property {number} port - HTTP server port
 * @property {number} udpPort - UDP relay server port
 * @property {string} nodeEnv - Node environment (development/production)
 * @property {boolean} forceHttps - Force HTTPS redirect
 * @property {string[]} corsOrigins - Allowed CORS origins
 * @property {string} turnServer - TURN server hostname
 * @property {string} turnSecret - TURN server secret for credentials
 * @property {number} turnTtl - TURN credential TTL in seconds
 * @property {string} adminToken - Admin API token
 * @property {Object} paths - File paths for data storage
 * @property {number} saltRounds - bcrypt salt rounds
 */
const config = {
  port: process.env.PORT || 3000,
  udpPort: parseInt(process.env.UDP_PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  forceHttps: process.env.FORCE_HTTPS === 'true',
  corsOrigins: process.env.CORS_ORIGINS 
    ? process.env.CORS_ORIGINS.split(',') 
    : ['http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:3000'],
  turnServer: process.env.TURN_SERVER,
  turnSecret: process.env.TURN_SECRET || '',
  turnTtl: 24 * 60 * 60,
  adminToken: process.env.ADMIN_TOKEN,
  paths: {
    users: path.join(__dirname, 'data', 'users.json'),
    sessions: path.join(__dirname, 'data', 'sessions.json'),
    whitelist: path.join(__dirname, 'data', 'whitelist.json'),
    avatars: path.join(__dirname, '..', 'avatars'),
  },
  saltRounds: 10,
};

/**
 * Validate environment variables and exit if critical ones missing in production
 * @returns {void}
 */
function validateEnv() {
  const warnings = [];
  const errors = [];
  
  if (!process.env.PORT) warnings.push('PORT not set, using default 3000');
  if (!process.env.CORS_ORIGINS) warnings.push('CORS_ORIGINS not set, allowing same origin only');
  if (config.nodeEnv === 'production' && !config.forceHttps) {
    warnings.push('FORCE_HTTPS not set in production');
  }
  
  if (!config.turnServer) warnings.push('TURN_SERVER not set, WebRTC may fail behind NAT');
  if (!config.turnSecret) {
    if (config.nodeEnv === 'production') {
      errors.push('TURN_SECRET required in production for WebRTC NAT traversal');
    } else {
      warnings.push('TURN_SECRET not set, WebRTC may fail behind NAT');
    }
  }
  
  if (!config.adminToken) {
    if (config.nodeEnv === 'production') {
      errors.push('ADMIN_TOKEN required in production for audit endpoint security');
    } else {
      warnings.push('ADMIN_TOKEN not set, /audit endpoint will be disabled');
    }
  }
  
  warnings.forEach(w => console.warn(`⚠️  ${w}`));
  
  if (errors.length > 0) {
    errors.forEach(e => console.error(`❌ ${e}`));
    console.error('Fix critical configuration errors before starting server');
    process.exit(1);
  }
  
  console.log('✓ Environment validated');
}

module.exports = { config, validateEnv };
