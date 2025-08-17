// routes/expressRoutes.js
const express = require('express');
const router = express.Router();
const expressController = require('../controllers/expressController');

// Example route
router.get('/', expressController.home);

// Add more routes and associate with controllers

module.exports = router;