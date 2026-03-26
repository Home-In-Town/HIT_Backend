const mongoose = require('mongoose');

const marketplaceListingSchema = new mongoose.Schema({
  // The project being listed for sale/buy
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: false,
    index: true
  },
  // Who listed this project
  listedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Listing type
  listingType: {
    type: String,
    enum: ['selling', 'buying'],
    required: true,
    index: true
  },
  // Commission details
  commissionType: {
    type: String,
    enum: ['percentage', 'fixed'],
    default: 'percentage'
  },
  commissionValue: {
    type: Number,
    required: true,
    min: 0
  },
  // Description / pitch for the listing
  description: {
    type: String,
    default: '',
    maxlength: 2000
  },
  // Listing visibility
  status: {
    type: String,
    enum: ['Active', 'Paused', 'Closed', 'Sold'],
    default: 'Active',
    index: true
  },
  // Expected deal value
  expectedValue: {
    type: Number,
    default: 0
  },
  // Tags for search/filtering
  tags: [{ type: String }],
  // Views count
  viewsCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Compound index for marketplace browsing
marketplaceListingSchema.index({ status: 1, listingType: 1, createdAt: -1 });

module.exports = mongoose.model('MarketplaceListing', marketplaceListingSchema);
