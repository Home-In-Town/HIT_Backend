const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crmController');
const { protect, restrictTo } = require('../middleware/auth');

// All CRM routes require authentication
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent'));

// Pipeline stats for dashboard
router.get('/pipeline-stats', crmController.getPipelineStats);

// Lead CRUD
router.post('/leads', crmController.createLead);
router.get('/leads', crmController.getLeads);
router.get('/leads/:id', crmController.getLeadById);
router.put('/leads/:id', crmController.updateLead);
router.put('/leads/:id/stage', crmController.updateLeadStage);
router.delete('/leads/:id', crmController.archiveLead);

module.exports = router;
