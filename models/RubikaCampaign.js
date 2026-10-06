import mongoose from 'mongoose';

const CampaignScheduleSchema = new mongoose.Schema({
    enabled: { type: Boolean, default: true },
    daysOfWeek: {
        type: [Number],
        default: [0, 1, 2, 3, 4, 5, 6],
        validate: {
            validator: value => value.every(day => Number.isInteger(day) && day >= 0 && day <= 6),
            message: 'روزهای هفته باید بین 0 تا 6 باشند.'
        }
    },
    startTime: { type: String, default: '10:00' },
    endTime: { type: String, default: '12:00' }
}, { _id: false });

const RubikaCampaignSchema = new mongoose.Schema({
    title: { type: String, required: true },
    type: { type: String, enum: ['normal', 'festival'], required: true },
    subjects: [{ type: String, required: true }],
    contentMode: { type: String, enum: ['text', 'image', 'text-image'], default: 'text' },
    images: { type: [String], default: [] },
    targetCategories: [{ type: String }],
    targetTags: [{ type: String }],
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    minDelaySeconds: { type: Number, default: 180 },
    maxDelaySeconds: { type: Number, default: 300 },
    schedule: { type: CampaignScheduleSchema, default: () => ({}) },
    status: { type: String, enum: ['idle', 'running', 'paused', 'cancelled', 'completed'], default: 'idle' },
    remainingDelaySeconds: { type: Number, default: 0 },
    totalSent: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
    dailyStats: {
        type: [{
            date: { type: String, required: true },
            sent: { type: Number, default: 0 },
            failed: { type: Number, default: 0 }
        }],
        default: []
    }
}, {
    timestamps: true,
    collection: 'rubika_campaigns'
});

export default mongoose.model('RubikaCampaign', RubikaCampaignSchema);
