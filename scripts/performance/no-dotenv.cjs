// Performance child only: prevent app dotenv.config() from opening any .env file.
const { createRequire } = require('node:module');
const path = require('node:path');
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
backendRequire('dotenv').config = () => ({ parsed: {} });
