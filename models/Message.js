import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    text: { type: String, required: true },
    type: { type: String, enum: ['normal', 'festival'], required: true }, // عادی یا جشنواره
    subject: { type: String, required: true } // 👈 موضوع پیام (مثلاً: هوش مصنوعی، معماری و...)
}, { timestamps: true });

export default mongoose.model('Message', messageSchema);