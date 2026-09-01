const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/captainTeamController');
const { protect, restrictTo } = require('../middleware/auth');

// Captain-to-captain team-up is a captain-only feature
router.use(protect);
router.use(restrictTo('captain'));

router.get('/me', ctrl.getMyTeam);
router.get('/captains', ctrl.listCaptains);
router.post('/request', ctrl.sendRequest);
router.post('/accept', ctrl.acceptRequest);
router.post('/decline', ctrl.declineRequest);
router.post('/remove', ctrl.removePartner);

module.exports = router;
