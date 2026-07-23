const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  url: String,
  key: String,
});

const projectSchema = new mongoose.Schema({
  projectName: { type: String, required: true },
  projectType: { type: String, default: 'flat' },
  category: { type: String, enum: ['Residential', 'Commercial', 'Mixed Use'] },
  propertyType: { type: String },

  // RBAC: Which builder/agent owns this project
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },

  // Agent assigned to this project by the captain (owner)
  assignedAgent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    default: null
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
  layoutEntities: [
    {
      id: String,
      type: { type: String, enum: ['project-boundary', 'subplot', 'road', 'ai-boundary'] },
      geometryType: { type: String, enum: ['polygon', 'polyline'] },
      path: [{ lat: Number, lng: Number }],
      aiBoundaryId: String,
      deleted: { type: Boolean, default: false },
      roadType: { type: String, enum: ['lane', 'internal', 'main'] },
      status: { type: String, enum: ['available', 'booked', 'sold', 'on-hold'] },
      plotNumber: String,
      area: Number,
      facing: { type: String, enum: ['north', 'south', 'east', 'west'] },
      roadName: String,
      saved: { type: Boolean, default: false }
    }
  ],
   media: {
    coverImage: fileSchema,
    galleryImages: [fileSchema],
    videos: [fileSchema],
    brochurePdf: fileSchema,
     layoutImage: fileSchema 
  },
  cta: {
    buttonText: { type: String, default: 'Book Site Visit' },
    whatsappNumber: String,
    callNumber: String
  },
  slug: { type: String, unique: true, sparse: true },
  status: { type: String, enum: ['draft', 'published', 'pending_approval', 'deleted'], default: 'draft' }
}, {
  timestamps: true
});

module.exports = mongoose.model('Project', projectSchema);
