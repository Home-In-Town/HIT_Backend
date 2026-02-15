const express = require('express');
const router = express.Router();

const Contact = require('../models/Contact');


// @route   GET /api/contacts
// @desc    Get recent contacts
// @access  Private (Admin)
router.get('/', async (req, res) => {
    try {
        const contacts = await Contact.find().sort({ createdAt: -1 }).limit(50);
        res.json(contacts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error fetching contacts' });
    }
});

// @route   POST /api/contacts/single
// @desc    Add a single contact
// @access  Private (Admin)
router.post('/single', async (req, res) => {
    try {
        const { name, phone } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ message: 'Name and phone are required' });
        }

        const newContact = new Contact({
            name,
            phone,
            source: 'manual'
        });

        await newContact.save();
        res.status(201).json(newContact);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error saving contact' });
    }
});

// Bulk upload route removed (unused and missing dependencies)

module.exports = router;
