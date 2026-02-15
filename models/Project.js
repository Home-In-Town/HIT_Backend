const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  projectName: { type: String, required: true },
  projectType: { type: String, default: 'flat' },
  builderName: String,
<<<<<<< HEAD
=======

  // RBAC: Which builder created this project
  builderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  city: String,
  location: String,
  latitude: Number,
  longitude: Number,
  googleMapLink: String,
  reraApproved: { type: Boolean, default: false },
  reraNumber: String,
  projectStatus: { type: String, default: 'pre-launch' },
<<<<<<< HEAD
  
=======

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  pricing: {
    startingPrice: Number,
    pricePerSqFt: Number,
    totalPriceRange: String,
    paymentPlan: String,
    bankLoanAvailable: { type: Boolean, default: false }
  },
<<<<<<< HEAD
  
=======

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  configuration: {
    bhkOptions: [String],
    carpetAreaRange: String,
    floorRange: String,
    plotSizeRange: String,
    facingOptions: [String],
    gatedCommunity: { type: Boolean, default: false }
  },
<<<<<<< HEAD
  
  amenities: [String],
  
=======

  amenities: [String],

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  media: {
    coverImage: String,
    galleryImages: [String],
    videos: [String],
    brochurePdf: String
  },
<<<<<<< HEAD
  
=======

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  cta: {
    buttonText: { type: String, default: 'Book Site Visit' },
    whatsappNumber: String,
    callNumber: String
  },
<<<<<<< HEAD
  
=======

>>>>>>> 864bb90622c8c453642199e1c6e79b332ee0a3ae
  slug: { type: String, unique: true, sparse: true },
  status: { type: String, default: 'draft' }
}, {
  timestamps: true
});

module.exports = mongoose.model('Project', projectSchema);
