import express from 'express';
import mongoose from 'mongoose';
import 'dotenv/config';
import cors from 'cors';
import multer from 'multer';
import xlsx from 'xlsx';
import path from 'path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';

import User from './models/User.js';
import Message from './models/Message.js';
import RubikaCampaign from './models/RubikaCampaign.js';

import {
    initRubikaService,
    getRubikaAuthStatus,
    sendCode,
    verifyCode,
    logoutRubika,
    resolveRubikaTarget,
    createRubikaContact,
    processRubikaAction,
    processRubikaImageAction
} from './rubikaService.js';

const app = express();

const dashboardLogs = [];
let dashboardLogId = 0;
const MAX_DASHBOARD_LOGS = 1000;

function serializeLogArg(value) {
    if (value instanceof Error) {
        return value.stack || value.message || String(value);
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function addDashboardLog(level, args) {
    const message = args
        .map(serializeLogArg)
        .join(' ')
        .trim();

    if (!message) return;

    const entry = {
        id: ++dashboardLogId,
        timestamp: new Date().toISOString(),
        level,
        message
    };

    dashboardLogs.push(entry);

    if (dashboardLogs.length > MAX_DASHBOARD_LOGS) {
        dashboardLogs.splice(
            0,
            dashboardLogs.length - MAX_DASHBOARD_LOGS
        );
    }
}

const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};

console.log = (...args) => {
    addDashboardLog('info', args);
    originalConsole.log(...args);
};

console.warn = (...args) => {
    addDashboardLog('warn', args);
    originalConsole.warn(...args);
};

console.error = (...args) => {
    addDashboardLog('error', args);
    originalConsole.error(...args);
};

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
    express.static(
        path.join(__dirname, 'FrontEnd')
    )
);

const IMAGE_DIR = path.join(
    __dirname,
    'uploads',
    'campaign-images'
);

await fs.mkdir(
    IMAGE_DIR,
    {
        recursive: true
    }
);

app.use(
    '/campaign-images',
    express.static(IMAGE_DIR)
);

const upload = multer({
    storage: multer.memoryStorage()
});


// ==========================================
// متغیرهای گلوبال برای مدیریت تایمر
// ==========================================

let activeTimeout = null;
let countdownInterval = null;
let currentRemainingSeconds = 0;
let currentCampaignId = null;


// ==========================================
// پاک‌سازی تایمرها
// ==========================================

function clearCampaignTimers() {

    if (activeTimeout) {
        clearTimeout(activeTimeout);
        activeTimeout = null;
    }

    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
}

const clearTimers = clearCampaignTimers;


// ==========================================
// وضعیت Runtime زمان‌بندی کمپین‌ها
// ==========================================

const campaignScheduleRuntime = new Map();
const campaignAutoSyncLocks = new Set();
let campaignSchedulerInterval = null;

function setCampaignRuntime(campaignId, data = {}) {
    const id = String(campaignId);

    campaignScheduleRuntime.set(
        id,
        {
            updatedAt: new Date().toISOString(),
            ...data
        }
    );
}

function getCampaignRuntime(campaignId) {
    return (
        campaignScheduleRuntime.get(
            String(campaignId)
        ) || null
    );
}

function clearCampaignRuntime(campaignId) {
    campaignScheduleRuntime.delete(
        String(campaignId)
    );
}

function buildCampaignScheduleRuntime(
    campaign,
    now = new Date()
) {

    const state =
        getScheduleState(
            campaign,
            now
        );

    const stored =
        getCampaignRuntime(
            campaign?._id
        );

    if (!state.valid) {

        return {
            mode: 'invalid',
            message: state.error,
            nextStart: null,
            nextEnd: null,
            updatedAt: new Date().toISOString()
        };

    }

    if (state.finished) {

        return {
            mode: 'finished',
            message: 'بازه زمانی کمپین به پایان رسیده است.',
            nextStart: null,
            nextEnd: null,
            updatedAt: new Date().toISOString()
        };

    }

    if (state.active) {

        return {
            mode:
                stored?.mode === 'auto-started'
                    ? 'auto-started'
                    : 'active',

            message:
                stored?.mode === 'auto-started'
                    ? stored.message
                    : 'کمپین در بازه مجاز در حال اجرا است.',

            nextStart: null,

            nextEnd:
                state.windowEnd
                    ? state.windowEnd.toISOString()
                    : null,

            updatedAt:
                stored?.updatedAt ||
                new Date().toISOString()
        };

    }

    return {
        mode:
            stored?.mode === 'auto-paused'
                ? 'auto-paused'
                : 'waiting',

        message:
            stored?.mode === 'auto-paused'
                ? stored.message
                : 'در انتظار بازه مجاز بعدی.',

        nextStart:
            state.nextStart
                ? state.nextStart.toISOString()
                : null,

        nextEnd: null,

        updatedAt:
            stored?.updatedAt ||
            new Date().toISOString()
    };
}

async function syncScheduledCampaigns() {

    if (campaignAutoSyncLocks.size > 0) {
        return;
    }

    try {

        const campaigns =
            await RubikaCampaign.find({
                status: {
                    $in: [
                        'idle',
                        'running'
                    ]
                }
            }).sort({
                createdAt: 1
            });

        let selectedRunningId = null;

        if (currentCampaignId) {

            const current =
                campaigns.find(
                    c =>
                        c._id.toString() ===
                        String(currentCampaignId)
                );

            if (current) {

                const currentState =
                    getScheduleState(
                        current,
                        new Date()
                    );

                if (
                    currentState.valid &&
                    currentState.active &&
                    current.status === 'running'
                ) {

                    selectedRunningId =
                        current._id.toString();

                }

            }

        }

        for (const campaign of campaigns) {

            const id =
                campaign._id.toString();

            if (
                campaignAutoSyncLocks.has(id)
            ) {
                continue;
            }

            const now = new Date();

            const state =
                getScheduleState(
                    campaign,
                    now
                );

            if (!state.valid) {

                setCampaignRuntime(
                    id,
                    {
                        mode: 'invalid',
                        message: state.error,
                        nextStart: null,
                        nextEnd: null
                    }
                );

                continue;
            }

            if (state.finished) {

                if (
                    campaign.status !==
                    'completed'
                ) {

                    campaign.status =
                        'completed';

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                }

                if (
                    String(currentCampaignId) ===
                    id
                ) {

                    clearCampaignTimers();

                    currentCampaignId =
                        null;

                    currentRemainingSeconds =
                        0;

                }

                setCampaignRuntime(
                    id,
                    {
                        mode: 'finished',
                        message:
                            'بازه زمانی کمپین به پایان رسیده است.',
                        nextStart: null,
                        nextEnd: null
                    }
                );

                continue;
            }

            if (state.active) {

                if (
                    campaign.status ===
                    'idle'
                ) {

                    if (
                        selectedRunningId &&
                        selectedRunningId !== id
                    ) {

                        setCampaignRuntime(
                            id,
                            {
                                mode: 'waiting',
                                message:
                                    'بازه زمانی فعال است اما کمپین دیگری در حال اجرا است.',
                                nextStart: null,
                                nextEnd:
                                    state.windowEnd
                                        ?.toISOString() ||
                                    null
                            }
                        );

                        continue;
                    }

                    campaignAutoSyncLocks.add(id);

                    try {

                        campaign.status =
                            'running';

                        campaign.remainingDelaySeconds =
                            0;

                        await campaign.save();

                        selectedRunningId =
                            id;

                        setCampaignRuntime(
                            id,
                            {
                                mode:
                                    'auto-started',

                                message:
                                    'کمپین به‌صورت خودکار در شروع بازه زمانی فعال شد.',

                                nextStart:
                                    null,

                                nextEnd:
                                    state.windowEnd
                                        ?.toISOString() ||
                                    null
                            }
                        );

                        runCampaignWorker(
                            campaign._id
                        );

                    } finally {

                        campaignAutoSyncLocks.delete(
                            id
                        );

                    }

                } else {

                    setCampaignRuntime(
                        id,
                        {
                            mode:
                                selectedRunningId === id
                                    ? 'active'
                                    : 'waiting',

                            message:
                                selectedRunningId === id
                                    ? 'کمپین در بازه مجاز در حال اجرا است.'
                                    : 'کمپین در دیتابیس در حال اجرا ثبت شده اما اجرای همزمان دیگری فعال است.',

                            nextStart: null,

                            nextEnd:
                                state.windowEnd
                                    ?.toISOString() ||
                                null
                        }
                    );

                    if (!selectedRunningId) {
                        selectedRunningId = id;
                    }

                }

                continue;
            }

            if (
                campaign.status ===
                'running'
            ) {

                campaignAutoSyncLocks.add(id);

                try {

                    campaign.status =
                        'idle';

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                    if (
                        String(currentCampaignId) ===
                        id
                    ) {

                        clearCampaignTimers();

                        currentCampaignId =
                            null;

                        currentRemainingSeconds =
                            0;

                    }

                    setCampaignRuntime(
                        id,
                        {
                            mode: 'auto-paused',

                            message:
                                state.nextStart
                                    ? `کمپین به‌دلیل خارج شدن از بازه زمانی متوقف شد. شروع خودکار بعدی: ${state.nextStart.toLocaleString('fa-IR')}`
                                    : 'کمپین به‌دلیل خارج شدن از بازه زمانی متوقف شد.',

                            nextStart:
                                state.nextStart
                                    ? state.nextStart.toISOString()
                                    : null,

                            nextEnd: null
                        }
                    );

                } finally {

                    campaignAutoSyncLocks.delete(
                        id
                    );

                }

                continue;
            }

            setCampaignRuntime(
                id,
                {
                    mode: 'waiting',

                    message:
                        state.nextStart
                            ? `در انتظار بازه مجاز بعدی. شروع خودکار: ${state.nextStart.toLocaleString('fa-IR')}`
                            : 'در انتظار بازه مجاز بعدی.',

                    nextStart:
                        state.nextStart
                            ? state.nextStart.toISOString()
                            : null,

                    nextEnd: null
                }
            );

        }

    } catch (error) {

        console.error(
            '❌ خطا در Scheduler کمپین:',
            error.message
        );

    }
}

function startCampaignScheduler() {

    if (campaignSchedulerInterval) {
        return;
    }

    syncScheduledCampaigns();

    campaignSchedulerInterval =
        setInterval(
            () => {
                syncScheduledCampaigns();
            },
            5000
        );

    console.log(
        '🗓️ RubikaCampaign Scheduler فعال شد؛ بررسی زمان‌بندی هر ۵ ثانیه.'
    );
}


// ==========================================
// ابزارهای زمان‌بندی کمپین
// ==========================================

const DEFAULT_MIN_DELAY_SECONDS = 180;
const DEFAULT_MAX_DELAY_SECONDS = 300;

function normalizeCampaignSchedule(
    schedule = {}
) {

    const daysOfWeek =
        Array.isArray(
            schedule.daysOfWeek
        )
            ? [
                ...new Set(
                    schedule.daysOfWeek
                        .map(Number)
                        .filter(
                            day =>
                                Number.isInteger(day) &&
                                day >= 0 &&
                                day <= 6
                        )
                )
            ]
            : [];

    return {
        enabled:
            schedule.enabled !== false,

        daysOfWeek:
            daysOfWeek.sort(
                (a, b) => a - b
            ),

        startTime:
            typeof schedule.startTime === 'string'
                ? schedule.startTime
                : '10:00',

        endTime:
            typeof schedule.endTime === 'string'
                ? schedule.endTime
                : '12:00'
    };
}

function timeToMinutes(time) {

    const match =
        /^(\d{2}):(\d{2})$/.exec(
            String(time || '')
        );

    if (!match) {
        return null;
    }

    const hours =
        Number(match[1]);

    const minutes =
        Number(match[2]);

    if (
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59
    ) {
        return null;
    }

    return (
        hours * 60 +
        minutes
    );
}

function normalizeDateOnly(value) {

    if (!value) {
        return null;
    }

    const text =
        String(value).trim();

    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
            text
        )
    ) {
        return null;
    }

    const [y, m, d] =
        text.split('-').map(Number);

    const date =
        new Date(
            y,
            m - 1,
            d
        );

    if (
        date.getFullYear() !== y ||
        date.getMonth() !== m - 1 ||
        date.getDate() !== d
    ) {
        return null;
    }

    return text;
}

function dateOnlyToLocalDate(value) {

    const normalized =
        normalizeDateOnly(value);

    if (!normalized) {
        return null;
    }

    const [y, m, d] =
        normalized
            .split('-')
            .map(Number);

    return new Date(
        y,
        m - 1,
        d,
        0,
        0,
        0,
        0
    );
}

function formatDateOnly(date) {

    const y =
        date.getFullYear();

    const m =
        String(
            date.getMonth() + 1
        ).padStart(2, '0');

    const d =
        String(
            date.getDate()
        ).padStart(2, '0');

    return `${y}-${m}-${d}`;
}

function updateCampaignDailyStat(
    campaign,
    field,
    date = new Date()
) {

    if (!campaign) {
        return;
    }

    const dateKey =
        formatDateOnly(date);

    if (
        !Array.isArray(
            campaign.dailyStats
        )
    ) {
        campaign.dailyStats = [];
    }

    let dayStat =
        campaign.dailyStats.find(
            item =>
                item.date === dateKey
        );

    if (!dayStat) {

        campaign.dailyStats.push({
            date: dateKey,
            sent: 0,
            failed: 0
        });

        dayStat =
            campaign.dailyStats[
            campaign.dailyStats.length - 1
            ];
    }

    if (field === 'sent') {

        dayStat.sent =
            Number(
                dayStat.sent || 0
            ) + 1;

    } else if (
        field === 'failed'
    ) {

        dayStat.failed =
            Number(
                dayStat.failed || 0
            ) + 1;

    }
}

function validateDateRange(
    startDate,
    endDate
) {

    const start =
        normalizeDateOnly(
            startDate
        );

    const end =
        normalizeDateOnly(
            endDate
        );

    if (!start || !end) {

        return {
            valid: false,
            error:
                'تاریخ شروع و پایان باید با فرمت YYYY-MM-DD باشند.'
        };

    }

    if (start > end) {

        return {
            valid: false,
            error:
                'تاریخ پایان نمی‌تواند قبل از تاریخ شروع باشد.'
        };

    }

    return {
        valid: true,
        startDate: start,
        endDate: end
    };
}

function normalizeDelayRange(
    minDelaySeconds,
    maxDelaySeconds
) {

    const min =
        Number(
            minDelaySeconds ??
            DEFAULT_MIN_DELAY_SECONDS
        );

    const max =
        Number(
            maxDelaySeconds ??
            DEFAULT_MAX_DELAY_SECONDS
        );

    if (
        !Number.isFinite(min) ||
        !Number.isFinite(max)
    ) {

        return {
            valid: false,
            error:
                'مقدار تأخیر باید عددی باشد.'
        };

    }

    if (
        !Number.isInteger(min) ||
        !Number.isInteger(max)
    ) {

        return {
            valid: false,
            error:
                'تأخیر باید بر حسب ثانیه و به صورت عدد صحیح باشد.'
        };

    }

    if (
        min < 1 ||
        max < 1
    ) {

        return {
            valid: false,
            error:
                'حداقل تأخیر ۱ ثانیه است.'
        };

    }

    if (min > max) {

        return {
            valid: false,
            error:
                'حداقل تأخیر نمی‌تواند بیشتر از حداکثر تأخیر باشد.'
        };

    }

    return {
        valid: true,
        minDelaySeconds: min,
        maxDelaySeconds: max
    };
}

function validateCampaignSchedule(
    schedule,
    startDate,
    endDate
) {

    const normalized =
        normalizeCampaignSchedule(
            schedule
        );

    if (
        !normalized.daysOfWeek.length
    ) {

        return {
            valid: false,
            error:
                'حداقل یک روز از هفته را انتخاب کنید.'
        };

    }

    const startMinutes =
        timeToMinutes(
            normalized.startTime
        );

    const endMinutes =
        timeToMinutes(
            normalized.endTime
        );

    if (
        startMinutes === null ||
        endMinutes === null
    ) {

        return {
            valid: false,
            error:
                'ساعت شروع و پایان باید با فرمت HH:MM باشند.'
        };

    }

    if (
        startMinutes >= endMinutes
    ) {

        return {
            valid: false,
            error:
                'ساعت پایان باید بعد از ساعت شروع باشد.'
        };

    }

    const dates =
        validateDateRange(
            startDate,
            endDate
        );

    if (!dates.valid) {
        return dates;
    }

    return {
        valid: true,
        schedule: normalized,
        startMinutes,
        endMinutes,
        startDate: dates.startDate,
        endDate: dates.endDate
    };
}

function getScheduleDelayRange(
    campaign
) {

    return normalizeDelayRange(
        campaign?.minDelaySeconds,
        campaign?.maxDelaySeconds
    );
}

function getDailyScheduleEstimate(
    schedule,
    minDelaySeconds,
    maxDelaySeconds
) {

    const checked =
        validateCampaignSchedule(
            schedule,
            '2000-01-01',
            '2099-12-31'
        );

    if (!checked.valid) {
        return null;
    }

    const delay =
        normalizeDelayRange(
            minDelaySeconds,
            maxDelaySeconds
        );

    if (!delay.valid) {
        return null;
    }

    const durationMs =
        (
            checked.endMinutes -
            checked.startMinutes
        ) *
        60 *
        1000;

    const minDelayMs =
        delay.maxDelaySeconds *
        1000;

    const maxDelayMs =
        delay.minDelaySeconds *
        1000;

    const avgDelayMs =
        (
            (
                delay.minDelaySeconds +
                delay.maxDelaySeconds
            ) / 2
        ) *
        1000;

    return {
        durationMinutes:
            Math.round(
                durationMs / 60000
            ),

        minMessages:
            Math.max(
                1,
                Math.ceil(
                    durationMs /
                    minDelayMs
                )
            ),

        maxMessages:
            Math.max(
                1,
                Math.ceil(
                    durationMs /
                    maxDelayMs
                )
            ),

        averageMessages:
            Math.max(
                1,
                Math.ceil(
                    durationMs /
                    avgDelayMs
                )
            ),

        minDelaySeconds:
            delay.minDelaySeconds,

        maxDelaySeconds:
            delay.maxDelaySeconds
    };
}

function countActiveDaysInRange(
    startDate,
    endDate,
    daysOfWeek
) {

    const start =
        dateOnlyToLocalDate(
            startDate
        );

    const end =
        dateOnlyToLocalDate(
            endDate
        );

    if (
        !start ||
        !end ||
        !Array.isArray(daysOfWeek) ||
        start > end
    ) {
        return 0;
    }

    const allowed =
        new Set(
            daysOfWeek.map(Number)
        );

    let count = 0;

    const cursor =
        new Date(start);

    while (cursor <= end) {

        if (
            allowed.has(
                cursor.getDay()
            )
        ) {
            count++;
        }

        cursor.setDate(
            cursor.getDate() + 1
        );
    }

    return count;
}

function getScheduleEstimateForRange(
    campaign
) {

    const daily =
        getDailyScheduleEstimate(
            campaign.schedule,
            campaign.minDelaySeconds,
            campaign.maxDelaySeconds
        );

    if (!daily) {
        return null;
    }

    const activeDays =
        countActiveDaysInRange(
            campaign.startDate,
            campaign.endDate,
            campaign.schedule?.daysOfWeek
        );

    return {
        ...daily,

        activeDays,

        totalMinMessages:
            daily.minMessages *
            activeDays,

        totalMaxMessages:
            daily.maxMessages *
            activeDays,

        totalAverageMessages:
            daily.averageMessages *
            activeDays
    };
}

function getDateAtMinutes(
    baseDate,
    minutes
) {

    const date =
        new Date(baseDate);

    date.setHours(
        Math.floor(minutes / 60),
        minutes % 60,
        0,
        0
    );

    return date;
}

function getNextScheduleStart(
    schedule,
    startDate,
    endDate,
    now = new Date()
) {

    const checked =
        validateCampaignSchedule(
            schedule,
            startDate,
            endDate
        );

    if (!checked.valid) {
        return null;
    }

    const rangeStart =
        dateOnlyToLocalDate(
            checked.startDate
        );

    const rangeEnd =
        dateOnlyToLocalDate(
            checked.endDate
        );

    const nowDateOnly =
        dateOnlyToLocalDate(
            formatDateOnly(now)
        );

    let cursor =
        nowDateOnly < rangeStart
            ? new Date(rangeStart)
            : new Date(nowDateOnly);

    for (
        let offset = 0;
        offset <= 3660;
        offset++
    ) {

        if (cursor > rangeEnd) {
            return null;
        }

        const day =
            cursor.getDay();

        if (
            checked.schedule.daysOfWeek.includes(
                day
            )
        ) {

            const candidate =
                new Date(cursor);

            candidate.setHours(
                Math.floor(
                    checked.startMinutes / 60
                ),
                checked.startMinutes % 60,
                0,
                0
            );

            if (candidate > now) {
                return candidate;
            }

        }

        cursor.setDate(
            cursor.getDate() + 1
        );
    }

    return null;
}

function getScheduleState(
    campaign,
    now = new Date()
) {

    const checked =
        validateCampaignSchedule(
            campaign?.schedule,
            campaign?.startDate,
            campaign?.endDate
        );

    if (!checked.valid) {

        return {
            valid: false,
            error: checked.error
        };

    }

    const today =
        formatDateOnly(now);

    if (
        today < checked.startDate
    ) {

        return {
            valid: true,
            active: false,

            nextStart:
                getNextScheduleStart(
                    campaign.schedule,
                    checked.startDate,
                    checked.endDate,
                    now
                )
        };

    }

    if (
        today > checked.endDate
    ) {

        return {
            valid: true,
            active: false,
            finished: true,
            nextStart: null
        };

    }

    if (
        checked.schedule.enabled ===
        false
    ) {

        const end =
            new Date(now);

        end.setHours(
            23,
            59,
            59,
            999
        );

        return {
            valid: true,
            active: true,
            windowEnd: end
        };

    }

    const currentDay =
        now.getDay();

    const currentMinutes =
        now.getHours() * 60 +
        now.getMinutes();

    if (
        !checked.schedule.daysOfWeek.includes(
            currentDay
        )
    ) {

        return {
            valid: true,
            active: false,

            nextStart:
                getNextScheduleStart(
                    campaign.schedule,
                    checked.startDate,
                    checked.endDate,
                    now
                )
        };

    }

    if (
        currentMinutes <
        checked.startMinutes
    ) {

        return {
            valid: true,
            active: false,

            nextStart:
                getDateAtMinutes(
                    now,
                    checked.startMinutes
                )
        };

    }

    if (
        currentMinutes >=
        checked.endMinutes
    ) {

        return {
            valid: true,
            active: false,

            nextStart:
                getNextScheduleStart(
                    campaign.schedule,
                    checked.startDate,
                    checked.endDate,
                    now
                )
        };

    }

    return {
        valid: true,
        active: true,

        windowEnd:
            getDateAtMinutes(
                now,
                checked.endMinutes
            )
    };
}

function getNextAllowedSendTime(
    campaign,
    now = new Date()
) {

    const state =
        getScheduleState(
            campaign,
            now
        );

    if (
        !state.valid ||
        state.finished
    ) {
        return null;
    }

    return state.active
        ? now
        : state.nextStart;
}


// ==========================================
// اتصال به MongoDB
// ==========================================

mongoose.connect(
    process.env.MONGO_URI
)
    .then(() => {

        console.log(
            '✅ Connected to MongoDB'
        );

        initRubikaService();

        startCampaignScheduler();

    })
    .catch(err => {

        console.error(
            '❌ MongoDB connection error:',
            err
        );

    });


// ==========================================
// API Routes
// ==========================================


// ==========================================
// ۱. آپلود فایل اکسل کاربران
// ==========================================

app.post(
    '/api/users/upload',
    upload.single('file'),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    error:
                        'هیچ فایلی ارسال نشده است.'
                });

            }

            const workbook =
                xlsx.read(
                    req.file.buffer,
                    {
                        type: 'buffer'
                    }
                );

            const sheetName =
                workbook.SheetNames[0];

            const sheet =
                workbook.Sheets[sheetName];

            const sheetData =
                xlsx.utils.sheet_to_json(
                    sheet
                );

            if (
                sheetData.length === 0
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'فایل اکسل خالی است یا داده‌ای در آن یافت نشد.'
                });

            }

            const firstRow =
                sheetData[0];

            const hasMobile =
                firstRow.hasOwnProperty(
                    'تلفن همراه'
                ) ||
                firstRow.hasOwnProperty(
                    'موبایل'
                ) ||
                firstRow.hasOwnProperty(
                    'mobile'
                );

            const hasBusiness =
                firstRow.hasOwnProperty(
                    'نام کسب‌وکار'
                ) ||
                firstRow.hasOwnProperty(
                    'businessName'
                );

            const hasCategory =
                firstRow.hasOwnProperty(
                    'نوع مخاطب'
                ) ||
                firstRow.hasOwnProperty(
                    'دسته'
                ) ||
                firstRow.hasOwnProperty(
                    'category'
                );

            const hasTags =
                firstRow.hasOwnProperty(
                    'تگ'
                ) ||
                firstRow.hasOwnProperty(
                    'tags'
                );

            const hasBlock =
                firstRow.hasOwnProperty(
                    'بلاک'
                ) ||
                firstRow.hasOwnProperty(
                    'block'
                );

            const missingColumns = [];

            if (!hasMobile) {
                missingColumns.push(
                    '«تلفن همراه»'
                );
            }

            if (!hasBusiness) {
                missingColumns.push(
                    '«نام کسب‌وکار»'
                );
            }

            if (!hasCategory) {
                missingColumns.push(
                    '«نوع مخاطب» (یا دسته)'
                );
            }

            if (!hasTags) {
                missingColumns.push(
                    '«تگ»'
                );
            }

            if (!hasBlock) {
                missingColumns.push(
                    '«بلاک»'
                );
            }

            if (
                missingColumns.length > 0
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        `خطا: فایل اکسل فاقد ستون‌های زیر است و وجود تمام آن‌ها الزامی است: ${missingColumns.join(', ')}`
                });

            }

            const newUsers = [];
            const memoryMobiles =
                new Set();

            let duplicateCount = 0;

            for (
                const row of sheetData
            ) {

                const mobile =
                    row['تلفن همراه']
                        ? String(
                            row['تلفن همراه']
                        ).trim()
                        : (
                            row['موبایل']
                                ? String(
                                    row['موبایل']
                                ).trim()
                                : null
                        );

                const businessName =
                    row['نام کسب‌وکار'] ||
                    row['businessName'];

                const category =
                    row['نوع مخاطب'] ||
                    row['دسته'] ||
                    row['category'];

                let tags = [];

                const rawTags =
                    row['تگ'] ||
                    row['tags'];

                if (rawTags) {

                    tags =
                        String(rawTags)
                            .split(',')
                            .map(
                                t =>
                                    t.trim()
                            )
                            .filter(
                                t =>
                                    t.length > 0
                            );

                }

                const rawBlock =
                    row['بلاک'] ||
                    row['block'];

                const isBlocked =
                    rawBlock === true ||
                    rawBlock === 1 ||
                    String(
                        rawBlock
                    ).toLowerCase() ===
                    'true' ||
                    String(
                        rawBlock
                    ).trim() ===
                    'بله';

                if (mobile) {

                    if (
                        memoryMobiles.has(
                            mobile
                        )
                    ) {

                        duplicateCount++;

                        continue;

                    }

                    const exists =
                        await User.findOne({
                            mobile
                        });

                    if (!exists) {

                        newUsers.push({
                            businessName,
                            mobile,
                            category,
                            tags,
                            isBlocked,
                            status: 'pending'
                        });

                        memoryMobiles.add(
                            mobile
                        );

                    } else {

                        duplicateCount++;

                    }

                }

            }

            if (
                newUsers.length > 0
            ) {

                await User.insertMany(
                    newUsers
                );

            }

            res.status(201).json({
                success: true,
                message:
                    'فایل با موفقیت آپلود و پردازش شد.',
                added:
                    newUsers.length,
                duplicatesIgnored:
                    duplicateCount
            });

        } catch (error) {

            console.error(
                'Excel Upload Error:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    'خطا در پردازش فایل اکسل.'
            });

        }

    }
);


// ==========================================
// ۲. دریافت لیست کاربران
// ==========================================

app.get(
    '/api/users',
    async (req, res) => {

        try {

            const users =
                await User.find()
                    .sort({
                        createdAt: -1
                    });

            res.json({
                success: true,
                count:
                    users.length,
                data:
                    users
            });

        } catch (error) {

            res.status(500).json({
                error:
                    'خطا در دریافت کاربران'
            });

        }

    }
);


// ==========================================
// ۳. ایجاد پیام جدید
// ==========================================

app.post(
    '/api/messages',
    async (req, res) => {

        try {

            const {
                text,
                subject
            } = req.body;

            if (!text || !subject) {

                return res.status(400).json({
                    success: false,
                    error:
                        'متن پیام و موضوع الزامی هستند.'
                });

            }

            const newMessage =
                await Message.create({
                    text,
                    subject,
                    type: 'normal'
                });

            res.status(201).json({
                success: true,
                data:
                    newMessage
            });

        } catch (error) {

            res.status(500).json({
                error:
                    'خطا در ثبت پیام'
            });

        }

    }
);


// ==========================================
// وارد کردن پیام‌ها از فایل اکسل
// ==========================================

app.post(
    '/api/messages/upload',
    upload.single('file'),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    error:
                        'هیچ فایلی ارسال نشده است.'
                });

            }

            const workbook =
                xlsx.read(
                    req.file.buffer,
                    {
                        type: 'buffer'
                    }
                );

            const sheet =
                workbook.Sheets[
                workbook.SheetNames[0]
                ];

            const rows =
                sheet
                    ? xlsx.utils.sheet_to_json(
                        sheet,
                        {
                            defval: ''
                        }
                    )
                    : [];

            if (!rows.length) {

                return res.status(400).json({
                    success: false,
                    error:
                        'فایل اکسل خالی است یا داده‌ای در آن یافت نشد.'
                });

            }

            const firstRow =
                rows[0];

            const subjectKey =
                Object.keys(
                    firstRow
                ).find(
                    key =>
                        [
                            'نوع',
                            'موضوع پیام',
                            'subject'
                        ].includes(
                            String(key)
                                .trim()
                                .toLowerCase()
                        )
                );

            const textKey =
                Object.keys(
                    firstRow
                ).find(
                    key =>
                        [
                            'متن پیام',
                            'متن',
                            'text',
                            'message'
                        ].includes(
                            String(key)
                                .trim()
                                .toLowerCase()
                        )
                );

            if (
                !subjectKey ||
                !textKey
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'فایل باید دو ستون «موضوع» و «متن پیام» داشته باشد.'
                });

            }

            const messages =
                rows
                    .map(row => ({
                        subject:
                            String(
                                row[
                                subjectKey
                                ] ?? ''
                            ).trim(),

                        text:
                            String(
                                row[
                                textKey
                                ] ?? ''
                            ).trim(),

                        type:
                            'normal'
                    }))
                    .filter(
                        row =>
                            row.subject &&
                            row.text
                    );

            if (!messages.length) {

                return res.status(400).json({
                    success: false,
                    error:
                        'هیچ ردیف معتبر دارای موضوع و متن پیام پیدا نشد.'
                });

            }

            const inserted =
                await Message.insertMany(
                    messages
                );

            return res.status(201).json({
                success: true,
                added:
                    inserted.length
            });

        } catch (error) {

            return res.status(500).json({
                success: false,
                error:
                    error.message ||
                    'خطا در وارد کردن پیام‌ها از اکسل.'
            });

        }

    }
);


// ==========================================
// ۴. دریافت لیست پیام‌ها
// ==========================================

app.get(
    '/api/messages',
    async (req, res) => {

        try {

            const messages =
                await Message.find()
                    .sort({
                        createdAt: -1
                    });

            res.json({
                success: true,
                count:
                    messages.length,
                data:
                    messages
            });

        } catch (error) {

            res.status(500).json({
                error:
                    'خطا در دریافت پیام‌ها'
            });

        }

    }
);


// ==========================================
// لیست موضوعات
// ==========================================

app.get(
    '/api/meta/subjects',
    async (req, res) => {

        try {

            const subjects =
                await Message.distinct(
                    'subject'
                );

            res.json({
                success: true,
                data:
                    subjects
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    'خطا در دریافت موضوعات'
            });

        }

    }
);


// ==========================================
// لیست دسته‌بندی‌ها
// ==========================================

app.get(
    '/api/meta/categories',
    async (req, res) => {

        try {

            const categories =
                await User.distinct(
                    'category'
                );

            res.json({
                success: true,
                data:
                    categories
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    'خطا در دریافت انواع مخاطبان'
            });

        }

    }
);


// ==========================================
// API لاگ‌های زنده داشبورد
// ==========================================

app.get(
    '/api/logs',
    (req, res) => {

        try {

            const afterId =
                Number(
                    req.query.after || 0
                );

            const logs =
                afterId > 0
                    ? dashboardLogs.filter(
                        log =>
                            log.id >
                            afterId
                    )
                    : [
                        ...dashboardLogs
                    ];

            res.json({
                success: true,
                logs,
                latestId:
                    dashboardLogId
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);

app.delete(
    '/api/logs',
    (req, res) => {

        dashboardLogs.length = 0;

        console.log(
            '🧹 لاگ‌های داشبورد توسط کاربر پاک شدند.'
        );

        res.json({
            success: true,
            message:
                'لاگ‌ها پاک شدند.'
        });

    }
);


// ==========================================
// کتابخانه تصاویر کمپین
// ==========================================

const imageUpload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                12 * 1024 * 1024,
            files: 1
        },

        fileFilter:
            (_req, file, cb) => {

                const allowed = [
                    'image/jpeg',
                    'image/png',
                    'image/webp'
                ];

                cb(
                    allowed.includes(
                        file.mimetype
                    )
                        ? null
                        : new Error(
                            'فقط تصویرهای JPG، PNG یا WEBP مجاز هستند.'
                        ),

                    allowed.includes(
                        file.mimetype
                    )
                );

            }
    });

app.get(
    '/api/images',
    async (_req, res) => {

        try {

            const files =
                await fs.readdir(
                    IMAGE_DIR,
                    {
                        withFileTypes:
                            true
                    }
                );

            const images =
                await Promise.all(
                    files
                        .filter(
                            f =>
                                f.isFile()
                        )
                        .map(
                            async f => {

                                const stat =
                                    await fs.stat(
                                        path.join(
                                            IMAGE_DIR,
                                            f.name
                                        )
                                    );

                                return {
                                    id:
                                        f.name,

                                    name:
                                        f.name,

                                    url:
                                        `/campaign-images/${encodeURIComponent(f.name)}`,

                                    size:
                                        stat.size,

                                    uploadedAt:
                                        stat.mtime.toISOString()
                                };

                            }
                        )
                );

            images.sort(
                (a, b) =>
                    b.uploadedAt.localeCompare(
                        a.uploadedAt
                    )
            );

            res.json({
                success: true,
                images
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);

app.post(
    '/api/images/upload',
    imageUpload.single('image'),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    error:
                        'یک تصویر انتخاب کنید.'
                });

            }

            const ext = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/webp': '.webp'
            }[
                req.file.mimetype
            ];

            const filename =
                `${crypto.randomUUID()}${ext}`;

            await fs.writeFile(
                path.join(
                    IMAGE_DIR,
                    filename
                ),
                req.file.buffer,
                {
                    flag: 'wx'
                }
            );

            res.status(201).json({
                success: true,

                image: {
                    id:
                        filename,

                    name:
                        filename,

                    url:
                        `/campaign-images/${encodeURIComponent(filename)}`
                }
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);

app.delete(
    '/api/images/:filename',
    async (req, res) => {

        try {

            const filename =
                path.basename(
                    String(
                        req.params.filename ||
                        ''
                    )
                );

            if (
                filename !==
                req.params.filename ||
                !/^[\w-]+\.(jpg|png|webp)$/i.test(
                    filename
                )
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'نام فایل نامعتبر است.'
                });

            }

            await fs.unlink(
                path.join(
                    IMAGE_DIR,
                    filename
                )
            );

            res.json({
                success: true
            });

        } catch (error) {

            res.status(404).json({
                success: false,
                error:
                    'تصویر پیدا نشد.'
            });

        }

    }
);


// ==========================================
// ۵. ساخت کمپین
// ==========================================

app.post(
    '/api/campaigns/create',
    async (req, res) => {

        try {

            const {
                title,
                type,
                subjects,
                contentMode = 'text',
                images = [],
                targetCategories,
                targetTags,
                schedule,
                startDate,
                endDate,
                minDelaySeconds,
                maxDelaySeconds
            } = req.body;

            const cleanTitle =
                String(
                    title || ''
                ).trim();

            const cleanSubjects =
                Array.isArray(subjects)
                    ? [
                        ...new Set(
                            subjects
                                .map(
                                    v =>
                                        String(v).trim()
                                )
                                .filter(
                                    Boolean
                                )
                        )
                    ]
                    : [];

            const cleanCategories =
                Array.isArray(
                    targetCategories
                )
                    ? [
                        ...new Set(
                            targetCategories
                                .map(
                                    v =>
                                        String(v).trim()
                                )
                                .filter(
                                    Boolean
                                )
                        )
                    ]
                    : [];

            const cleanTags =
                Array.isArray(targetTags)
                    ? [
                        ...new Set(
                            targetTags
                                .map(
                                    v =>
                                        String(v).trim()
                                )
                                .filter(
                                    Boolean
                                )
                        )
                    ]
                    : [];

            if (!cleanTitle) {

                return res.status(400).json({
                    success: false,
                    error:
                        'عنوان کمپین الزامی است.'
                });

            }

            if (
                ![
                    'normal',
                    'festival'
                ].includes(type)
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'نوع کمپین نامعتبر است.'
                });

            }

            const cleanContentMode =
                [
                    'text',
                    'image',
                    'text-image'
                ].includes(
                    contentMode
                )
                    ? contentMode
                    : 'text';

            const cleanImages =
                Array.isArray(images)
                    ? [
                        ...new Set(
                            images
                                .map(
                                    v =>
                                        path.basename(
                                            String(v)
                                        )
                                )
                                .filter(
                                    v =>
                                        /^[\w-]+\.(jpg|png|webp)$/i.test(
                                            v
                                        )
                                )
                        )
                    ]
                    : [];

            if (
                cleanContentMode !==
                'image' &&
                !cleanSubjects.length
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'حداقل یک موضوع پیام را انتخاب کنید.'
                });

            }

            if (
                cleanContentMode !==
                'text' &&
                !cleanImages.length
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'برای حالت تصویری حداقل یک تصویر انتخاب کنید.'
                });

            }

            if (
                cleanContentMode !==
                'text'
            ) {

                for (
                    const imageName of cleanImages
                ) {

                    try {

                        await fs.access(
                            path.join(
                                IMAGE_DIR,
                                imageName
                            )
                        );

                    } catch {

                        return res.status(400).json({
                            success: false,
                            error:
                                `تصویر ${imageName} در کتابخانه پیدا نشد.`
                        });

                    }

                }

            }

            if (
                !cleanCategories.length
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'حداقل یک دسته‌بندی مخاطب را انتخاب کنید.'
                });

            }

            const scheduleCheck =
                validateCampaignSchedule(
                    schedule,
                    startDate,
                    endDate
                );

            if (!scheduleCheck.valid) {

                return res.status(400).json({
                    success: false,
                    error:
                        scheduleCheck.error
                });

            }

            const delayCheck =
                normalizeDelayRange(
                    minDelaySeconds,
                    maxDelaySeconds
                );

            if (!delayCheck.valid) {

                return res.status(400).json({
                    success: false,
                    error:
                        delayCheck.error
                });

            }

            const campaign =
                new RubikaCampaign({

                    title:
                        cleanTitle,

                    type,

                    subjects:
                        cleanSubjects,

                    contentMode:
                        cleanContentMode,

                    images:
                        cleanImages,

                    targetCategories:
                        cleanCategories,

                    targetTags:
                        cleanTags,

                    startDate:
                        scheduleCheck.startDate,

                    endDate:
                        scheduleCheck.endDate,

                    minDelaySeconds:
                        delayCheck.minDelaySeconds,

                    maxDelaySeconds:
                        delayCheck.maxDelaySeconds,

                    schedule:
                        scheduleCheck.schedule
                });

            await campaign.save();

            res.status(201).json({

                success: true,

                campaign,

                scheduleEstimate:
                    getScheduleEstimateForRange(
                        campaign
                    )

            });

        } catch (error) {

            console.error(
                'RubikaCampaign Create Error:',
                error
            );

            res.status(500).json({
                success: false,
                error:
                    error.message
            });

        }

    }
);


// ==========================================
// ۶. استارت کمپین
// ==========================================

app.post(
    '/api/campaigns/:id/start',
    async (req, res) => {

        try {

            const campaign =
                await RubikaCampaign.findById(
                    req.params.id
                );

            if (!campaign) {

                return res.status(404).json({
                    success: false,
                    message:
                        'کمپین یافت نشد'
                });

            }

            if (
                campaign.status ===
                'completed'
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'این کمپین تکمیل شده است.'
                });

            }

            const scheduleState =
                getScheduleState(
                    campaign,
                    new Date()
                );

            if (!scheduleState.valid) {

                return res.status(400).json({
                    success: false,
                    message:
                        scheduleState.error
                });

            }

            if (
                !scheduleState.active
            ) {

                campaign.status =
                    'idle';

                campaign.remainingDelaySeconds =
                    0;

                await campaign.save();

                setCampaignRuntime(
                    campaign._id,
                    {
                        mode: 'waiting',

                        message:
                            scheduleState.nextStart
                                ? `کمپین خارج از بازه زمانی است. شروع خودکار: ${scheduleState.nextStart.toLocaleString('fa-IR')}`
                                : 'کمپین خارج از بازه زمانی است و بازه بعدی وجود ندارد.',

                        nextStart:
                            scheduleState.nextStart
                                ? scheduleState.nextStart.toISOString()
                                : null,

                        nextEnd: null
                    }
                );

                return res.json({

                    success: true,

                    waitingForSchedule:
                        true,

                    message:
                        scheduleState.nextStart
                            ? `کمپین در بازه بعدی به‌صورت خودکار شروع می‌شود: ${scheduleState.nextStart.toLocaleString('fa-IR')}`
                            : 'کمپین خارج از بازه زمانی است.'
                });

            }

            campaign.status =
                'running';

            campaign.remainingDelaySeconds =
                0;

            await campaign.save();

            setCampaignRuntime(
                campaign._id,
                {
                    mode: 'active',

                    message:
                        'کمپین به‌صورت دستی در بازه مجاز شروع شد.',

                    nextStart: null,

                    nextEnd:
                        scheduleState.windowEnd
                            ? scheduleState.windowEnd.toISOString()
                            : null
                }
            );

            runCampaignWorker(
                campaign._id
            );

            res.json({
                success: true,
                message:
                    'کمپین شروع شد'
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error:
                    err.message
            });

        }

    }
);


// ==========================================
// ۷. توقف موقت یا لغو کمپین
// ==========================================

app.post(
    '/api/campaigns/:id/stop',
    async (req, res) => {

        try {

            const campaignForSchedule =
                await RubikaCampaign.findById(
                    req.params.id
                );

            if (!campaignForSchedule) {

                return res.status(404).json({
                    success: false,
                    error:
                        'کمپین یافت نشد.'
                });

            }

            const scheduleState =
                getScheduleState(
                    campaignForSchedule,
                    new Date()
                );

            if (!scheduleState.valid) {

                return res.status(400).json({
                    success: false,
                    error:
                        scheduleState.error
                });

            }

            if (!scheduleState.active) {

                return res.status(400).json({
                    success: false,
                    error:
                        'توقف یا تغییر وضعیت دستی کمپین فقط در بازه زمانی مجاز امکان‌پذیر است.'
                });

            }

            const {
                status
            } = req.body;

            const newStatus =
                status === 'cancelled'
                    ? 'cancelled'
                    : 'paused';

            const secondsToSave =
                newStatus === 'paused'
                    ? Math.max(
                        0,
                        currentRemainingSeconds
                    )
                    : 0;

            const campaign =
                await RubikaCampaign.findByIdAndUpdate(
                    req.params.id,
                    {
                        status:
                            newStatus,

                        remainingDelaySeconds:
                            secondsToSave
                    },
                    {
                        new: true
                    }
                );

            setCampaignRuntime(
                req.params.id,
                {
                    mode:
                        newStatus ===
                            'cancelled'
                            ? 'cancelled'
                            : 'paused',

                    message:
                        newStatus ===
                            'cancelled'
                            ? 'کمپین لغو شده است و Scheduler آن را خودکار شروع نمی‌کند.'
                            : 'کمپین به‌صورت دستی متوقف شده است و Scheduler آن را خودکار شروع نمی‌کند.',

                    nextStart: null,
                    nextEnd: null
                }
            );

            if (
                currentCampaignId ===
                req.params.id
            ) {

                clearCampaignTimers();

                currentRemainingSeconds =
                    0;

                currentCampaignId =
                    null;

            }

            res.json({

                success: true,

                message:
                    newStatus ===
                        'paused'
                        ? 'کمپین متوقف شد'
                        : 'کمپین لغو شد',

                data: {

                    status:
                        campaign?.status ||
                        newStatus,

                    remainingSeconds:
                        newStatus ===
                            'paused'
                            ? secondsToSave
                            : 0

                }

            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error:
                    err.message
            });

        }

    }
);


// ==========================================
// ۸. حذف کمپین
// ==========================================

app.delete(
    '/api/campaigns/:id',
    async (req, res) => {

        try {

            await RubikaCampaign.findByIdAndDelete(
                req.params.id
            );

            clearCampaignRuntime(
                req.params.id
            );

            if (
                String(currentCampaignId) ===
                String(req.params.id)
            ) {

                clearCampaignTimers();

                currentCampaignId =
                    null;

                currentRemainingSeconds =
                    0;

            }

            res.json({
                success: true,
                message:
                    'کمپین با موفقیت حذف شد'
            });

        } catch (error) {

            res.status(500).json({
                error:
                    error.message
            });

        }

    }
);


// ==========================================
// اضافه کردن کاربر دستی
// ==========================================

app.post(
    '/api/users/add',
    async (req, res) => {

        try {

            const {
                businessName,
                mobile,
                category,
                tags,
                isBlocked,
                rubikaGuid
            } = req.body;

            if (!mobile) {

                return res.status(400).json({
                    success: false,
                    error:
                        'شماره موبایل الزامی است.'
                });

            }

            const exists =
                await User.findOne({
                    mobile
                });

            if (exists) {

                return res.status(400).json({
                    success: false,
                    error:
                        'این شماره موبایل قبلاً ثبت شده است.'
                });

            }

            const newUser =
                await User.create({

                    businessName:
                        businessName ||
                        'نامشخص',

                    mobile,

                    category:
                        category ||
                        'مشتری',

                    tags:
                        tags
                            ? tags
                                .split(',')
                                .map(
                                    t =>
                                        t.trim()
                                )
                            : [],

                    isBlocked:
                        isBlocked ||
                        false,

                    rubikaGuid:
                        rubikaGuid ||
                        null,

                    rubikaStatus:
                        'pending'

                });

            res.status(201).json({

                success: true,

                message:
                    'کاربر با موفقیت اضافه شد.',

                data:
                    newUser

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==========================================
// ویرایش اطلاعات کاربر
// ==========================================

app.put(
    '/api/users/:id',
    async (req, res) => {

        try {

            const {
                businessName,
                mobile,
                category,
                tags,
                isBlocked,
                rubikaGuid
            } = req.body;

            const updateData = {

                businessName,

                mobile,

                category,

                isBlocked

            };

            if (
                rubikaGuid !==
                undefined
            ) {

                updateData.rubikaGuid =
                    rubikaGuid ||
                    null;

            }

            if (tags) {

                updateData.tags =
                    typeof tags ===
                        'string'
                        ? tags
                            .split(',')
                            .map(
                                t =>
                                    t.trim()
                            )
                        : tags;

            }

            const updatedUser =
                await User.findByIdAndUpdate(
                    req.params.id,
                    updateData,
                    {
                        new: true
                    }
                );

            if (!updatedUser) {

                return res.status(404).json({
                    success: false,
                    error:
                        'کاربر یافت نشد.'
                });

            }

            res.json({

                success: true,

                message:
                    'اطلاعات کاربر به‌روزرسانی شد.',

                data:
                    updatedUser

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==========================================
// حذف کاربر
// ==========================================

app.delete(
    '/api/users/:id',
    async (req, res) => {

        try {

            const deletedUser =
                await User.findByIdAndDelete(
                    req.params.id
                );

            if (!deletedUser) {

                return res.status(404).json({
                    success: false,
                    error:
                        'کاربر یافت نشد.'
                });

            }

            res.json({

                success: true,

                message:
                    'کاربر با موفقیت حذف شد.'

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==========================================
// جستجوی کاربران
// ==========================================

app.get(
    '/api/users/search',
    async (req, res) => {

        try {

            const query =
                req.query.q;

            if (!query) {

                return res.json({
                    success: true,
                    data: []
                });

            }

            const users =
                await User.find({

                    $or: [

                        {
                            mobile: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }
                        },

                        {
                            businessName: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }
                        },

                        {
                            category: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }

                        }

                    ]

                }).limit(20);

            res.json({

                success: true,

                count:
                    users.length,

                data:
                    users

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    'خطا در جستجوی مخاطب'

            });

        }

    }
);


// ==========================================
// ۹. وضعیت کامل کمپین
// ==========================================

app.get(
    '/api/campaigns/:id/status',
    async (req, res) => {

        try {

            const campaign =
                await RubikaCampaign.findById(
                    req.params.id
                );

            if (!campaign) {

                return res.status(404).json({

                    success: false,

                    error:
                        'کمپین مورد نظر یافت نشد.'

                });

            }

            const userQuery = {

                isBlocked: {
                    $ne: true
                },

                rubikaStatus: {
                    $ne: 'not_registered'
                }

            };

            if (
                campaign.targetCategories &&
                campaign.targetCategories.length > 0
            ) {

                userQuery.category = {
                    $in:
                        campaign.targetCategories
                };

            }

            if (
                campaign.targetTags &&
                campaign.targetTags.length > 0
            ) {

                userQuery.tags = {
                    $in:
                        campaign.targetTags
                };

            }

            const totalUsers =
                await User.countDocuments(
                    userQuery
                );

            const sentUsers =
                await User.countDocuments({

                    ...userQuery,

                    'rubikaReceivedMessages.messageType':
                        campaign.type

                });

            const pendingUsers =
                totalUsers -
                sentUsers;

            res.json({

                success: true,

                data: {

                    campaignId:
                        campaign._id,

                    title:
                        campaign.title,

                    type:
                        campaign.type,

                    subjects:
                        campaign.subjects,

                    targetCategories:
                        campaign.targetCategories,

                    targetTags:
                        campaign.targetTags,

                    startDate:
                        campaign.startDate,

                    endDate:
                        campaign.endDate,

                    minDelaySeconds:
                        campaign.minDelaySeconds,

                    maxDelaySeconds:
                        campaign.maxDelaySeconds,

                    schedule:
                        campaign.schedule,

                    scheduleRuntime:
                        buildCampaignScheduleRuntime(
                            campaign,
                            new Date()
                        ),

                    scheduleEstimate:
                        getScheduleEstimateForRange(
                            campaign
                        ),

                    status:
                        campaign.status,

                    totalSent:
                        campaign.totalSent,

                    totalFailed:
                        campaign.totalFailed,

                    dailyStats:
                        Array.isArray(
                            campaign.dailyStats
                        )
                            ? campaign.dailyStats
                                .map(
                                    item => ({
                                        date:
                                            item.date,

                                        sent:
                                            Number(
                                                item.sent ||
                                                0
                                            ),

                                        failed:
                                            Number(
                                                item.failed ||
                                                0
                                            )
                                    })
                                )
                                .sort(
                                    (a, b) =>
                                        a.date.localeCompare(
                                            b.date
                                        )
                                )
                            : [],

                    remainingSeconds:

                        (
                            currentCampaignId ===
                            campaign._id.toString() &&

                            campaign.status ===
                            'running'

                        )
                            ? currentRemainingSeconds

                            : (
                                campaign.remainingDelaySeconds ||
                                0
                            ),

                    stats: {

                        totalUsers,

                        sentUsers,

                        pendingUsers,

                        progressPercent:

                            totalUsers > 0
                                ? (
                                    (
                                        sentUsers /
                                        totalUsers
                                    ) * 100
                                ).toFixed(1)
                                : 0

                    },

                    createdAt:
                        campaign.createdAt,

                    updatedAt:
                        campaign.updatedAt

                }

            });

        } catch (error) {

            console.error(
                'RubikaCampaign Status Error:',
                error
            );

            res.status(500).json({

                success: false,

                error:
                    'خطا در دریافت وضعیت کمپین.'

            });

        }

    }
);


// ==========================================
// دریافت لیست کمپین‌ها
// ==========================================

app.get(
    '/api/campaigns',
    async (req, res) => {

        try {

            const campaigns =
                await RubikaCampaign.find()
                    .sort({
                        createdAt: -1
                    });

            res.json({

                success: true,

                count:
                    campaigns.length,

                data:
                    campaigns

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    'خطا در دریافت لیست کمپین‌ها'

            });

        }

    }
);


// ==========================================
// دریافت لیست تگ‌ها
// ==========================================

app.get(
    '/api/meta/tags',
    async (req, res) => {

        try {

            const tags =
                await User.distinct(
                    'tags'
                );

            res.json({

                success: true,

                data:
                    tags

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    'خطا در دریافت تگ‌ها'

            });

        }

    }
);


// ==========================================
// جستجوی پیام‌ها
// ==========================================

app.get(
    '/api/messages/search',
    async (req, res) => {

        try {

            const query =
                req.query.q;

            if (!query) {

                return res.json({

                    success: true,

                    data: []

                });

            }

            const messages =
                await Message.find({

                    $or: [

                        {
                            subject: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }
                        },

                        {
                            text: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }
                        },

                        {
                            type: {
                                $regex:
                                    query,
                                $options:
                                    'i'
                            }

                        }

                    ]

                }).limit(20);

            res.json({

                success: true,

                count:
                    messages.length,

                data:
                    messages

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    'خطا در جستجوی پیام‌ها'

            });

        }

    }
);


// ==========================================
// ویرایش پیام
// ==========================================

app.put(
    '/api/messages/:id',
    async (req, res) => {

        try {

            const {
                text,
                subject
            } = req.body;

            const updatedMessage =
                await Message.findByIdAndUpdate(

                    req.params.id,

                    {
                        text,
                        subject
                    },

                    {
                        new: true
                    }

                );

            if (!updatedMessage) {

                return res.status(404).json({

                    success: false,

                    error:
                        'پیام مورد نظر یافت نشد.'

                });

            }

            res.json({

                success: true,

                message:
                    'پیام با موفقیت به‌روزرسانی شد.',

                data:
                    updatedMessage

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==========================================
// افزودن مخاطب روبیکا
// ==========================================

app.post(
    '/api/rubika/contacts/add',
    async (req, res) => {

        try {

            const {
                name,
                mobile
            } = req.body;

            if (
                !name ||
                !String(name).trim()
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'نام مخاطب ارسال نشده است.'
                });

            }

            if (
                !mobile ||
                !String(mobile).trim()
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        'شماره موبایل ارسال نشده است.'
                });

            }

            const result =
                await createRubikaContact(
                    name,
                    mobile
                );

            return res.json(
                result
            );

        } catch (error) {

            console.error(
                '[RubikaServer] ❌ خطا در افزودن مخاطب:',
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    error.message ||
                    'خطای ناشناخته'

            });

        }

    }
);


// ==========================================
// Resolve مخاطب روبیکا
// ==========================================

app.post(
    '/api/rubika/contacts/resolve',
    async (req, res) => {

        try {

            const {
                mobile
            } = req.body;

            if (!mobile) {

                return res.status(400).json({

                    success: false,

                    error:
                        'شماره موبایل ارسال نشده است.'

                });

            }

            const result =
                await resolveRubikaTarget(
                    mobile
                );

            return res.json({

                success: true,

                ...result

            });

        } catch (error) {

            console.error(
                '[RubikaServer] ❌ خطا در resolve مخاطب:',
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    error.message ||
                    'خطای ناشناخته'

            });

        }

    }
);


// ==========================================
// حذف پیام
// ==========================================

app.delete(
    '/api/messages/:id',
    async (req, res) => {

        try {

            const deletedMessage =
                await Message.findByIdAndDelete(
                    req.params.id
                );

            if (!deletedMessage) {

                return res.status(404).json({

                    success: false,

                    error:
                        'پیام مورد نظر یافت نشد.'

                });

            }

            res.json({

                success: true,

                message:
                    'پیام با موفقیت حذف شد.'

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    error.message

            });

        }

    }
);


// ==========================================
// آمار پیام‌ها بر اساس موضوع
// ==========================================

app.get(
    '/api/messages/stats/by-subject',
    async (req, res) => {

        try {

            const stats =
                await Message.aggregate([

                    {
                        $group: {

                            _id:
                                '$subject',

                            count: {
                                $sum: 1
                            }

                        }

                    }

                ]);

            res.json({

                success: true,

                data:
                    stats

            });

        } catch (error) {

            res.status(500).json({

                success: false,

                error:
                    'خطا در دریافت آمار پیام‌ها'

            });

        }

    }
);


// ==========================================
// موتور پردازش کمپین‌ها
// ==========================================

export const runCampaignWorker = (
    campaignId
) => {

    clearTimers();

    currentCampaignId =
        campaignId.toString();

    currentRemainingSeconds =
        0;

    const scheduleNextRun =
        async (
            delayMs,
            options = {}
        ) => {

            clearTimers();

            const safeDelayMs =
                Math.max(
                    0,
                    Math.floor(
                        delayMs
                    )
                );

            currentRemainingSeconds =
                Math.floor(
                    safeDelayMs / 1000
                );

            if (
                options.persist !==
                false
            ) {

                try {

                    await RubikaCampaign.findByIdAndUpdate(
                        campaignId,
                        {
                            remainingDelaySeconds:
                                currentRemainingSeconds
                        }
                    );

                } catch (error) {

                    console.error(
                        '❌ خطا در ذخیره تایمر کمپین:',
                        error.message
                    );

                }

            }

            console.log(
                `⏳ زمان انتظار تا اجرای بعدی: ${Math.floor(currentRemainingSeconds / 60)} دقیقه و ${currentRemainingSeconds % 60} ثانیه.`
            );

            countdownInterval =
                setInterval(
                    () => {

                        currentRemainingSeconds =
                            Math.max(
                                0,
                                currentRemainingSeconds -
                                1
                            );

                        if (
                            currentRemainingSeconds >
                            0
                        ) {

                            const mins =
                                Math.floor(
                                    currentRemainingSeconds /
                                    60
                                );

                            const secs =
                                currentRemainingSeconds %
                                60;

                            process.stdout.write(
                                `\r⏱️ زمان باقی‌مانده تا اجرای بعدی: ${mins} دقیقه و ${secs < 10 ? '0' : ''}${secs} ثانیه   `
                            );

                        } else {

                            clearInterval(
                                countdownInterval
                            );

                            countdownInterval =
                                null;

                            process.stdout.write(
                                '\r                                                                       \r'
                            );

                        }

                    },
                    1000
                );

            activeTimeout =
                setTimeout(
                    async () => {

                        if (
                            countdownInterval
                        ) {

                            clearInterval(
                                countdownInterval
                            );

                            countdownInterval =
                                null;

                        }

                        currentRemainingSeconds =
                            0;

                        try {

                            await RubikaCampaign.findByIdAndUpdate(
                                campaignId,
                                {
                                    remainingDelaySeconds:
                                        0
                                }
                            );

                        } catch (error) {

                            console.error(
                                '❌ خطا در پاک‌کردن تایمر کمپین:',
                                error.message
                            );

                        }

                        runStep();

                    },
                    safeDelayMs
                );

        };

    const scheduleAtNextAllowedWindow =
        async (
            campaign,
            reason = ''
        ) => {

            const nextAllowed =
                getNextAllowedSendTime(
                    campaign,
                    new Date()
                );

            if (!nextAllowed) {

                console.error(
                    '❌ زمان‌بندی کمپین نامعتبر است.'
                );

                campaign.status =
                    'paused';

                campaign.remainingDelaySeconds =
                    0;

                await campaign.save();

                clearTimers();

                return true;

            }

            const delayMs =
                Math.max(
                    0,
                    nextAllowed.getTime() -
                    Date.now()
                );

            console.log(
                `🗓️ کمپین خارج از بازه ارسال است${reason ? ` (${reason})` : ''}. شروع بازه بعدی: ${nextAllowed.toLocaleString('fa-IR')}`
            );

            setCampaignRuntime(
                campaignId,
                {
                    mode: 'waiting',

                    message:
                        `در انتظار بازه مجاز بعدی. شروع خودکار: ${nextAllowed.toLocaleString('fa-IR')}`,

                    nextStart:
                        nextAllowed.toISOString(),

                    nextEnd:
                        null
                }
            );

            await scheduleNextRun(
                delayMs,
                {
                    persist: true
                }
            );

            return true;

        };

    const runStep =
        async () => {

            try {

                console.log(
                    '⏳ Worker: Checking campaign status...'
                );

                const campaign =
                    await RubikaCampaign.findById(
                        campaignId
                    );

                if (
                    !campaign ||
                    campaign.status !==
                    'running'
                ) {

                    console.log(
                        '🛑 کمپین متوقف، لغو یا پایان یافته است.'
                    );

                    clearTimers();

                    return;

                }

                const scheduleCheck =
                    validateCampaignSchedule(
                        campaign.schedule,
                        campaign.startDate,
                        campaign.endDate
                    );

                if (!scheduleCheck.valid) {

                    console.error(
                        `❌ زمان‌بندی کمپین نامعتبر است: ${scheduleCheck.error}`
                    );

                    campaign.status =
                        'paused';

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                    clearTimers();

                    return;

                }

                const scheduleState =
                    getScheduleState(
                        campaign,
                        new Date()
                    );

                if (
                    scheduleState.finished
                ) {

                    campaign.status =
                        'completed';

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                    clearTimers();

                    return;

                }

                if (
                    !scheduleState.active
                ) {

                    if (
                        !scheduleState.nextStart
                    ) {

                        campaign.status =
                            'completed';

                        campaign.remainingDelaySeconds =
                            0;

                        await campaign.save();

                        clearTimers();

                        return;

                    }

                    await scheduleAtNextAllowedWindow(
                        campaign,
                        'خارج از روز یا ساعت مجاز'
                    );

                    return;

                }

                // ==========================================
                // Resume تایمر ذخیره‌شده
                // ==========================================

                if (

                    (!activeTimeout &&
                        !countdownInterval) &&

                    currentRemainingSeconds ===
                    0 &&

                    campaign.remainingDelaySeconds &&

                    campaign.remainingDelaySeconds >
                    0

                ) {

                    const resumeSeconds =
                        campaign.remainingDelaySeconds;

                    const remainingWindowMs =
                        scheduleState.windowEnd.getTime() -
                        Date.now();

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                    if (
                        resumeSeconds * 1000 <
                        remainingWindowMs
                    ) {

                        console.log(
                            `⏸️ Resume تایمر از روی دیتابیس: ${resumeSeconds} ثانیه باقی‌مانده.`
                        );

                        await scheduleNextRun(
                            resumeSeconds * 1000,
                            {
                                persist: true
                            }
                        );

                        return;

                    }

                    await scheduleAtNextAllowedWindow(
                        campaign,
                        'تایمر Resume از انتهای بازه عبور می‌کند'
                    );

                    return;

                }


                // ==========================================
                // ساخت Query کاربران
                // ==========================================
                //
                // مهم:
                // دیگر rubikaGuid شرط انتخاب کاربر نیست.
                //
                // سرویس Rubika هنگام ارسال:
                // mobile -> contact -> chat -> GUID
                //
                // را خودش انجام می‌دهد.
                // ==========================================

                let matchQuery = {

                    isBlocked: {
                        $ne: true
                    },

                    /*
                     * کاربری که حساب روبیکا ندارد،
                     * فقط از صف روبیکا خارج می‌شود.
                     * User مشترک با بله باقی می‌ماند.
                     */
                    rubikaStatus: {
                        $ne: 'not_registered'
                    }

                };

                if (
                    campaign.targetCategories &&
                    campaign.targetCategories.length >
                    0
                ) {

                    matchQuery.category = {
                        $in:
                            campaign.targetCategories
                    };

                }

                if (
                    campaign.targetTags &&
                    campaign.targetTags.length >
                    0
                ) {

                    matchQuery.tags = {
                        $in:
                            campaign.targetTags
                    };

                }

                // ==========================================
                // منطق نوع کمپین
                // ==========================================

                if (
                    campaign.type ===
                    'festival'
                ) {

                    matchQuery[
                        'rubikaReceivedMessages.messageType'
                    ] = {
                        $ne:
                            'festival'
                    };

                } else {

                    matchQuery.rubikaStatus =
                        'pending';

                    matchQuery[
                        'rubikaReceivedMessages.messageType'
                    ] = {
                        $ne:
                            'normal'
                    };

                }


                // ==========================================
                // انتخاب رندوم کاربر
                // ==========================================

                const randomUsers =
                    await User.aggregate([

                        {
                            $match:
                                matchQuery
                        },

                        {
                            $sample: {
                                size: 1
                            }
                        }

                    ]);

                const targetUser =
                    randomUsers.length > 0

                        ? await User.findById(
                            randomUsers[0]._id
                        )

                        : null;

                if (!targetUser) {

                    console.log(
                        `✨ تمام کاربران واجد شرایط برای کمپین ${campaign.type} پیام دریافت کرده‌اند.`
                    );

                    campaign.status =
                        'completed';

                    campaign.remainingDelaySeconds =
                        0;

                    await campaign.save();

                    clearTimers();

                    return;

                }


                // ==========================================
                // Cooldown یک ماهه برای normal
                // ==========================================

                if (
                    campaign.type ===
                    'normal'
                ) {

                    const oneMonthAgo =
                        new Date();

                    oneMonthAgo.setMonth(
                        oneMonthAgo.getMonth() -
                        1
                    );

                    const receivedMessages =
                        Array.isArray(
                            targetUser.rubikaReceivedMessages
                        )
                            ? targetUser.rubikaReceivedMessages
                            : [];

                    const hasRecentNormal =
                        receivedMessages.some(

                            m =>
                                m.messageType ===
                                'normal' &&

                                m.sentAt >
                                oneMonthAgo

                        );

                    if (
                        hasRecentNormal
                    ) {

                        console.log(
                            `⏳ کاربر ${targetUser.mobile} در ۱ ماه گذشته پیام عادی گرفته است. رد شدن...`
                        );

                        targetUser.rubikaStatus =
                            'sent';

                        await targetUser.save();

                        await scheduleNextRun(
                            2000,
                            {
                                persist: true
                            }
                        );

                        return;

                    }

                }


                // ==========================================
                // انتخاب پیام
                // ==========================================

                let messageQuery = {};

                if (
                    campaign.subjects &&
                    campaign.subjects.length >
                    0
                ) {

                    messageQuery.subject = {
                        $in:
                            campaign.subjects
                    };

                }

                const messagesPool =
                    await Message.find(
                        messageQuery
                    );

                if (
                    messagesPool.length === 0 &&
                    campaign.contentMode !==
                    'image'
                ) {

                    console.log(
                        `⚠️ هیچ پیامی با شرایط نوع ${campaign.type} و موضوعات انتخاب‌شده یافت نشد!`
                    );

                    await scheduleNextRun(
                        10000,
                        {
                            persist: true
                        }
                    );

                    return;

                }


                // ==========================================
                // انتخاب تصادفی پیام
                // ==========================================

                const randomMessage =
                    messagesPool.length
                        ? messagesPool[
                        Math.floor(
                            Math.random() *
                            messagesPool.length
                        )
                        ]
                        : null;


                // ==========================================
                // انتخاب تصادفی تصویر
                // ==========================================

                const imagePool =
                    Array.isArray(
                        campaign.images
                    )
                        ? campaign.images
                        : [];

                const randomImage =
                    campaign.contentMode !==
                        'text' &&
                        imagePool.length

                        ? imagePool[
                        Math.floor(
                            Math.random() *
                            imagePool.length
                        )
                        ]

                        : null;

                if (
                    campaign.contentMode !==
                    'text' &&
                    !randomImage
                ) {

                    console.error(
                        `❌ کمپین ${campaign.title} تصویر انتخاب‌شده ندارد.`
                    );

                    await scheduleNextRun(
                        10000,
                        {
                            persist: true
                        }
                    );

                    return;

                }


                // ==========================================
                // اطلاعات گیرنده
                // ==========================================

                const userLabel =
                    targetUser.businessName

                        ? `${targetUser.businessName} | ${targetUser.mobile}`

                        : targetUser.mobile;


                console.log(
                    `📤 ارسال کمپین | گیرنده: ${userLabel} | کمپین: ${campaign.title} | حالت: ${campaign.contentMode || 'text'} | موضوع: ${randomMessage?.subject || '—'} | تصویر: ${randomImage || '—'}`
                );


                // ==========================================
                // ارسال
                //
                // مهم:
                // مثل Bale، سرویس فقط mobile دریافت می‌کند.
                //
                // انتخاب پیام و تصویر اینجا انجام شده و
                // سرویس Rubika هیچ دخالتی در Random ندارد.
                // ==========================================

                const sendStartedAt =
                    new Date();

                const sendResult =
                    campaign.contentMode ===
                        'image'

                        ? await processRubikaImageAction(
                            targetUser.mobile,
                            path.join(
                                IMAGE_DIR,
                                randomImage
                            ),
                            ''
                        )

                        : campaign.contentMode ===
                            'text-image'

                            ? await processRubikaImageAction(
                                targetUser.mobile,
                                path.join(
                                    IMAGE_DIR,
                                    randomImage
                                ),
                                randomMessage?.text ||
                                ''
                            )

                            : await processRubikaAction(
                                targetUser.mobile,
                                randomMessage.text
                            );


                // ==========================================
                // بررسی نتیجه ارسال
                // ==========================================

                const isSuccess =
                    sendResult === true ||
                    sendResult?.success === true;

                const isPermanentFailure =
                    sendResult?.permanentFailure ===
                    true;


                // ==========================================
                // ارسال موفق
                // ==========================================

                if (isSuccess) {

                    if (
                        !Array.isArray(
                            targetUser.rubikaReceivedMessages
                        )
                    ) {

                        targetUser.rubikaReceivedMessages =
                            [];

                    }

                    targetUser.rubikaReceivedMessages.push({

                        messageType:
                            campaign.type,

                        subject:
                            randomMessage?.subject ||
                            (
                                randomImage
                                    ? `تصویر: ${randomImage}`
                                    : '—'
                            ),

                        sentAt:
                            new Date()

                    });

                    if (
                        campaign.type ===
                        'normal'
                    ) {

                        targetUser.rubikaStatus =
                            'sent';

                    }

                    await targetUser.save();

                    campaign.totalSent += 1;

                    updateCampaignDailyStat(
                        campaign,
                        'sent',
                        new Date()
                    );

                    await campaign.save();

                    console.log(
                        `✅ ارسال موفق | گیرنده: ${userLabel} | وضعیت: پیام ارسال شد | زمان شروع: ${sendStartedAt.toLocaleString('fa-IR')}`
                    );

                } else {

                    // ==========================================
                    // ارسال ناموفق
                    //
                    // permanentFailure فقط در صورت خطای
                    // دائمی باعث حذف کاربر از صف می‌شود.
                    // ==========================================

                    if (
                        isPermanentFailure
                    ) {

                        if (
                            sendResult?.reason ===
                            'RUBIKA_ACCOUNT_NOT_FOUND'
                        ) {
                            /*
                             * User را غیرفعال نمی‌کنیم؛ چون همان User
                             * در دیتابیس بله نیز استفاده می‌شود.
                             */
                            targetUser.rubikaStatus =
                                'not_registered';

                            targetUser.rubikaGuid =
                                null;

                            await targetUser.save();

                            console.log(
                                `❌ حساب روبیکا ندارد | گیرنده: ${userLabel} | فقط از صف روبیکا حذف شد و کاربر بله دست‌نخورده باقی ماند | زمان: ${new Date().toLocaleString('fa-IR')}`
                            );
                        } else {
                            targetUser.isActive =
                                false;

                            await targetUser.save();

                            console.log(
                                `❌ ارسال ناموفق دائمی | گیرنده: ${userLabel} | کاربر از صف ارسال حذف شد | زمان: ${new Date().toLocaleString('fa-IR')}`
                            );
                        }

                    } else {

                        console.log(
                            `⚠️ ارسال ناموفق موقت | گیرنده: ${userLabel} | کاربر حذف نشد و برای تلاش مجدد باقی می‌ماند | زمان: ${new Date().toLocaleString('fa-IR')}`
                        );

                    }

                    campaign.totalFailed += 1;

                    updateCampaignDailyStat(
                        campaign,
                        'failed',
                        new Date()
                    );

                    await campaign.save();

                    console.log(
                        '⏱️ تلاش بعدی به دلیل ناموفق بودن ارسال، ۱۵ ثانیه دیگر انجام می‌شود.'
                    );

                    await scheduleNextRun(
                        15000,
                        {
                            persist: true
                        }
                    );

                    return;

                }


                // ==========================================
                // بررسی آخرین وضعیت کمپین
                // ==========================================

                const latestCampaign =
                    await RubikaCampaign.findById(
                        campaignId
                    );

                if (
                    !latestCampaign ||
                    latestCampaign.status !==
                    'running'
                ) {

                    clearTimers();

                    return;

                }


                // ==========================================
                // Delay رندوم کمپین
                // ==========================================

                const delayRange =
                    getScheduleDelayRange(
                        latestCampaign
                    );

                if (!delayRange.valid) {

                    console.error(
                        `❌ تنظیمات تأخیر کمپین نامعتبر است: ${delayRange.error}`
                    );

                    latestCampaign.status =
                        'paused';

                    latestCampaign.remainingDelaySeconds =
                        0;

                    await latestCampaign.save();

                    clearTimers();

                    return;

                }

                const randomDelay =
                    Math.floor(
                        Math.random() *
                        (
                            delayRange.maxDelaySeconds -
                            delayRange.minDelaySeconds +
                            1
                        )
                    ) +
                    delayRange.minDelaySeconds;

                const randomDelayMs =
                    randomDelay *
                    1000;

                const latestScheduleState =
                    getScheduleState(
                        latestCampaign,
                        new Date()
                    );

                if (
                    !latestScheduleState.valid
                ) {

                    clearTimers();

                    return;

                }

                const remainingWindowMs =
                    latestScheduleState.active

                        ? latestScheduleState.windowEnd.getTime() -
                        Date.now()

                        : 0;

                if (
                    !latestScheduleState.active ||
                    randomDelayMs >=
                    remainingWindowMs
                ) {

                    await scheduleAtNextAllowedWindow(
                        latestCampaign,
                        'تاخیر بعدی از انتهای بازه عبور می‌کند'
                    );

                    return;

                }

                await scheduleNextRun(
                    randomDelayMs,
                    {
                        persist: true
                    }
                );

            } catch (error) {

                console.error(
                    '❌ خطا در پردازشگر کمپین:',
                    error.message
                );

                await scheduleNextRun(
                    10000,
                    {
                        persist: true
                    }
                );

            }

        };

    runStep();

};


// ==========================================
// اجرای سرور
// ==========================================

const PORT =
    process.env.PORT ||
    5000;

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Backend Server running on http://localhost:${PORT}`
        );

    }
);