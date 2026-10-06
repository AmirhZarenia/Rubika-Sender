import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({

    mobile: {
        type: String,
        required: true,
        unique: true
    },

    businessName: {
        type: String,
        required: true
    },

    category: {
        type: String,
        default: 'مشتری',
        required: true
    },

    tags: [{
        type: String,
        required: true
    }],

    isBlocked: {
        type: Boolean,
        default: false,
        required: true
    },

    isActive: {
        type: Boolean,
        default: true
    },

    // ==========================================
    // Rubika-specific fields
    // ==========================================

    // GUID مخاطب در روبیکا
    rubikaGuid: {
        type: String,
        default: null,
        sparse: true
    },

    // وضعیت اختصاصی کاربر در روبیکا
    //
    // pending:
    // هنوز وضعیت ارسال روبیکا مشخص نشده
    //
    // sent:
    // ارسال موفق روبیکا انجام شده
    //
    // not_registered:
    // این شماره حساب روبیکا ندارد و از صف روبیکا خارج می‌شود
    //
    rubikaStatus: {
        type: String,
        enum: [
            'pending',
            'sent',
            'not_registered'
        ],
        default: 'pending'
    },

    // تاریخچه پیام‌های ارسال‌شده در روبیکا
    // مستقل از Bale
    rubikaReceivedMessages: [{

        messageType: {
            type: String,
            enum: [
                'normal',
                'festival'
            ]
        },

        subject: {
            type: String
        },

        sentAt: {
            type: Date,
            default: Date.now
        }

    }],

    // ==========================================
    // Bale-specific fields
    // ==========================================

    // تاریخچه پیام‌های ارسال‌شده در Bale
    // مستقل از Rubika
    receivedMessages: [{

        messageType: {
            type: String,
            enum: [
                'normal',
                'festival'
            ]
        },

        subject: {
            type: String
        },

        sentAt: {
            type: Date,
            default: Date.now
        }

    }],

    // وضعیت کلی کاربر برای Bale
    status: {
        type: String,
        enum: [
            'pending',
            'sent'
        ],
        default: 'pending'
    }

}, {
    timestamps: true,
    collection: 'users'
});

export default mongoose.model('User', userSchema);

