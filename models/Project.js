const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  url: String,
  key: String,
});

const projectSchema = new mongoose.Schema({
  projectName: { type: String, required: true },
  projectType: { type: String, default: 'flat' },
  builderName: String,

  // RBAC: Which builder/agent owns this project
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

  city: String,
  location: String,
  latitude: Number,
  longitude: Number,
  googleMapLink: String,
  reraApproved: { type: Boolean, default: false },
  reraNumber: String,
  projectStatus: { type: String, default: 'pre-launch' },
  pricing: {
    startingPrice: Number,
    pricePerSqFt: Number,
    totalPriceRange: String,
    paymentPlan: String,
    bankLoanAvailable: { type: Boolean, default: false }
  },
  configuration: {
    bhkOptions: [String],
    carpetAreaRange: String,
    floorRange: String,
    plotSizeRange: String,
    facingOptions: [String],
    gatedCommunity: { type: Boolean, default: false }
  },

  amenities: [String],
  landmarks: [
    {
      name: String,
      type: { type: String },
      lat: Number,
      lng: Number,
      address: String,
      placeId: String
    }
  ],
   media: {
    coverImage: fileSchema,
    galleryImages: [fileSchema],
    videos: [fileSchema],
    brochurePdf: fileSchema
  },
  cta: {
    buttonText: { type: String, default: 'Book Site Visit' },
    whatsappNumber: String,
    callNumber: String
  },
  slug: { type: String, unique: true, sparse: true },
  status: { type: String, default: 'draft' }
}, {
  timestamps: true
});

module.exports = mongoose.model('Project', projectSchema);
