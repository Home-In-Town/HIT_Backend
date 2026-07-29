const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/crmBridgeController');
const journeyCtrl = require('../controllers/leadJourneyController');
const { protect, restrictTo } = require('../middleware/auth');

const crmAuth = [protect, restrictTo('admin', 'builder', 'agent', 'captain')];

// ── Connection Management ────────────────────────────────────────────────────
router.post('/link',              ...crmAuth, ctrl.link);
router.post('/link-by-identifier', ...crmAuth, ctrl.linkByIdentifier);
router.post('/unlink',            ...crmAuth, ctrl.unlink);
router.post('/auto-link',         ...crmAuth, ctrl.autoLink);
router.post('/create-account',    ...crmAuth, ctrl.createAccount);
router.get('/status',             protect,    ctrl.status);
router.get('/redirect-base',      protect,    ctrl.getRedirectBase);

// ── CRM Data ─────────────────────────────────────────────────────────────────
router.get('/leads',              ...crmAuth, ctrl.getLeads);
router.get('/leads/:leadId',      ...crmAuth, ctrl.getLeadById);
router.get('/analytics',          ...crmAuth, ctrl.getAnalytics);
router.post('/sso-token',         ...crmAuth, ctrl.issueSsoToken);

// ── Lead Journey / Sales Funnel Timeline ─────────────────────────────────────
router.get('/journey/funnel',                    ...crmAuth, journeyCtrl.getFunnel);
router.get('/journey/recent',                    ...crmAuth, journeyCtrl.getRecentActivity);
router.get('/journey/:leadId',                   ...crmAuth, journeyCtrl.getJourney);
router.post('/journey/:leadId/advance',          ...crmAuth, journeyCtrl.advanceStage);
router.put('/journey/:leadId/property-interest', ...crmAuth, journeyCtrl.updatePropertyInterest);

module.exports = router;
