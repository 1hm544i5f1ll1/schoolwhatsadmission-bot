// index.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./config/index');
require('./controllers/whatsappController'); // Initializes the bot

const app = express();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`);
});