const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/crmBridgeController');
const { protect, restrictTo } = require('../middleware/auth');

const crmAuth = [protect, restrictTo('admin', 'builder', 'agent')];

router.post('/link',           ...crmAuth, ctrl.link);
router.post('/unlink',         ...crmAuth, ctrl.unlink);
router.get('/status',          protect,    ctrl.status);
router.get('/leads',           ...crmAuth, ctrl.getLeads);
router.get('/leads/:leadId',   ...crmAuth, ctrl.getLeadById);
router.get('/analytics',       ...crmAuth, ctrl.getAnalytics);
router.post('/sso-token',      ...crmAuth, ctrl.issueSsoToken);

module.exports = router;
