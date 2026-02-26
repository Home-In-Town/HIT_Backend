const express = require('express');
const router = express.Router();
const CallController = require('../controllers/CallController');

console.log("📞 calls.routes.js loaded");
router.get('/status/:callId', (req, res) => CallController.getStatus(req, res));
router.post('/new', (req, res) => CallController.newCall(req, res));
router.get('/logs', (req, res) => CallController.getLogs(req, res));
router.get('/logs/project/:projectId', (req, res) => CallController.getLogsByProject(req, res));
router.get('/logs/number/:number', (req, res) => CallController.getLogsByNumber(req, res));

module.exports = router;
