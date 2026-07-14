const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/crmBridgeController');
const { protect, restrictTo } = require('../middleware/auth');

const crmAuth = [protect, restrictTo('admin', 'builder', 'agent', 'captain')];

router.post('/link',           ...crmAuth, ctrl.link);
router.post('/unlink',         ...crmAuth, ctrl.unlink);
router.post('/auto-link',      ...crmAuth, ctrl.autoLink);          // auto-detect & link by phone/email
router.get('/status',          protect,    ctrl.status);
router.get('/redirect-base',   protect,    ctrl.getRedirectBase);   // SSO base URL for frontend
router.get('/leads',           ...crmAuth, ctrl.getLeads);
router.get('/leads/:leadId',   ...crmAuth, ctrl.getLeadById);
router.get('/analytics',       ...crmAuth, ctrl.getAnalytics);
router.post('/sso-token',      ...crmAuth, ctrl.issueSsoToken);

module.exports = router;
