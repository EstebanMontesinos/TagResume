const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Set working directory to where the exe is running from
process.chdir(path.dirname(process.execPath));

// Load .env from same folder as exe
require('dotenv').config({ path: path.join(path.dirname(process.execPath), '.env') });

// Start the server
require('./server.js');

// Open browser after 2 seconds
setTimeout(() => {
  exec('start http://localhost:3000');
}, 2000);
