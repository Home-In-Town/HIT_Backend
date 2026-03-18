const User = require('../models/User');
const MeetingLog = require('../models/MeetingLog');
const LocationHistory = require('../models/LocationHistory');

/**
 * Employer only: Search unassigned employees by phone
 */
exports.search = async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Phone number is required' });

        // Find users who are either 'unassigned' or 'employee'
        const employee = await User.findOne({
            phone: { $regex: phone + '$' },
            role: { $in: ['unassigned', 'employee'] }
        }).select('name phone role employerId');

        if (!employee) {
            return res.status(404).json({ error: 'Available employee not found with this phone' });
        }

        const employeeObj = employee.toObject();
        const isAlreadyAssigned = !!employee.employerId;

        res.json({
            ...employeeObj,
            isAlreadyAssigned
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Employer only: Request an employee
 */
exports.requestAssignment = async (req, res) => {
    try {
        const { employeeId } = req.body;
        if (!employeeId) return res.status(400).json({ error: 'Employee ID is required' });

        const employee = await User.findById(employeeId);
        if (!employee || !['unassigned', 'employee'].includes(employee.role)) {
            return res.status(404).json({ error: 'Available employee not found' });
        }

        if (employee.employerId) {
            if (employee.employerId.toString() === req.user._id.toString()) {
                return res.status(400).json({ error: 'Assignment request is already pending or confirmed' });
            }
            return res.status(400).json({ error: 'Employee is already assigned to another employer' });
        }

        employee.employerId = req.user._id;
        employee.isEmployerConfirmed = false;
        await employee.save();

        res.json({ message: 'Assignment request sent to employee', employee });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Unassigned user or Employee: Confirm assignment request
 */
exports.confirmAssignment = async (req, res) => {
    try {
        if (!req.user.employerId) {
            return res.status(400).json({ error: 'No pending assignment request' });
        }

        req.user.isEmployerConfirmed = true;
        req.user.role = 'employee'; // transition to employee role
        await req.user.save();

        res.json({ message: 'Assignment confirmed successfully', user: req.user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Employee only: Submit real-time location
 */
exports.submitLocation = async (req, res) => {
    try {
        const { latitude, longitude, placeName } = req.body;
        if (latitude === undefined || longitude === undefined) {
            return res.status(400).json({ error: 'Latitude and longitude are required' });
        }

        const newLocation = new LocationHistory({
            userId: req.user._id,
            latitude,
            longitude,
            placeName
        });
        await newLocation.save();

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Employee only: Log a meeting
 */
exports.logMeeting = async (req, res) => {
    try {
        const { withWhom, description, latitude, longitude, placeName, projectName, projectLocation, projectPrice } = req.body;
        
        if (!withWhom || !description) {
            return res.status(400).json({ error: 'withWhom and description are required' });
        }

        if (!req.user.employerId || !req.user.isEmployerConfirmed) {
            return res.status(403).json({ error: 'Employer assignment not confirmed' });
        }

        const log = new MeetingLog({
            employeeId: req.user._id,
            employerId: req.user.employerId,
            withWhom,
            description,
            location: { latitude, longitude, placeName },
            projectName,
            projectLocation,
            projectPrice
        });
        await log.save();

        res.json({ message: 'Meeting logged successfully', log });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Employer only: List their employees (including pending ones)
 */
exports.getMyEmployees = async (req, res) => {
    try {
        let query = {};

        if (req.user.role === 'admin') {
            // Admins see all users with an employerId OR the role 'employee'
            query = {
                $or: [
                    { role: 'employee' },
                    { employerId: { $ne: null } }
                ]
            };
        } else {
            // Builders/Agents see users assigned to them
            query = {
                employerId: req.user._id
            };
        }

        const employees = await User.find(query)
            .select('name phone email isActive role isEmployerConfirmed employerId')
            .populate('employerId', 'name phone');

        res.json(employees);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Employer only: Get tracking and meeting history for their employee
 */
exports.getHistory = async (req, res) => {
    try {
        const { employeeId } = req.params;
        
        const employee = await User.findById(employeeId);
        if (!employee) return res.status(404).json({ error: 'Employee not found' });

        if (req.user.role === 'employee' && req.user._id.toString() !== employeeId) {
             return res.status(403).json({ error: 'Not authorized to view other employee history' });
        }

        if (req.user.role !== 'employee' && req.user.role !== 'admin') {
            // Ensure this employer owns this employee
            if (employee.employerId?.toString() !== req.user._id.toString() || !employee.isEmployerConfirmed) {
                return res.status(403).json({ error: 'Not authorized to view this employee history' });
            }
        }

        const meetings = await MeetingLog.find({ employeeId }).sort({ createdAt: -1 });
        const locations = await LocationHistory.find({ userId: employeeId }).sort({ createdAt: -1 }).limit(100);

        res.json({
            employee: {
                name: employee.name,
                phone: employee.phone
            },
            meetings,
            locations
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
