const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/humanLeadController');
const { protect, restrictTo } = require('../middleware/auth');

// All Human Lead Manager routes require auth.
// Visible to the CRM roles + captain/agent/employee teams.
router.use(protect);
router.use(restrictTo('admin', 'builder', 'agent', 'captain', 'employee'));

// Agents a captain/admin can assign leads to (must be before /:id)
router.get('/team-agents', ctrl.getTeamAgents);

// Lead CRUD
router.post('/', ctrl.createLead);
router.get('/', ctrl.getLeads);
router.get('/:id', ctrl.getLeadById);
router.put('/:id', ctrl.updateLead);
router.put('/:id/stage', ctrl.updateStage);
router.put('/:id/assign', ctrl.assignAgent);

module.exports = router;
