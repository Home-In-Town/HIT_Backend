const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const { protect, restrictTo } = require('../middleware/auth');

/**
 * GET /api/employee/search
 * Employer only: Search unassigned employees by phone
 */
router.get('/search', protect, restrictTo('builder', 'agent', 'admin', 'captain'), employeeController.search);

/**
 * POST /api/employee/request-assignment
 * Employer only: Request an employee
 */
router.post('/request-assignment', protect, restrictTo('builder', 'agent', 'admin', 'captain'), employeeController.requestAssignment);

/**
 * POST /api/employee/confirm-assignment
 * Unassigned user or Employee: Confirm assignment request
 */
router.post('/confirm-assignment', protect, restrictTo('unassigned', 'employee'), employeeController.confirmAssignment);

/**
 * POST /api/employee/location
 * Employee only: Submit real-time location
 */
router.post('/location', protect, restrictTo('employee'), employeeController.submitLocation);

/**
 * POST /api/employee/meeting
 * Employee only: Log a meeting
 */
router.post('/meeting', protect, restrictTo('employee'), employeeController.logMeeting);

/**
 * GET /api/employee/my-employees
 * Employer only: List their employees
 */
router.get('/my-employees', protect, restrictTo('builder', 'agent', 'admin', 'captain'), employeeController.getMyEmployees);

/**
 * GET /api/employee/history/:employeeId
 * Employer only: Get tracking and meeting history for their employee
 */
router.get('/history/:employeeId', protect, restrictTo('builder', 'agent', 'admin', 'captain', 'employee'), employeeController.getHistory);

module.exports = router;
