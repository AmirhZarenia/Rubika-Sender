import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import 'dotenv/config';

const SESSION_DIR = path.resolve(
    process.env.RUBIKA_SESSION_DIR || './rubika_session'
);

const CHROME_PATH =
    process.env.RUBIKA_CHROME_PATH ||
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

const RUBIKA_URL =
    process.env.RUBIKA_WEB_URL || 'https://web.rubika.ir';

const MAX_SEND_ATTEMPTS = Math.max(
    1,
    Number(process.env.RUBIKA_MAX_SEND_ATTEMPTS || 3)
);

const RETRY_MS = Math.max(
    1000,
    Number(process.env.RUBIKA_RETRY_MS || 3000)
);

const execFileAsync = promisify(execFile);

const UI_TIMEOUT = Math.max(
    5000,
    Number(process.env.RUBIKA_UI_TIMEOUT_MS || 15000)
);

let browser = null;
let page = null;
let initialized = false;

/*
|--------------------------------------------------------------------------
| Action Queue
|--------------------------------------------------------------------------
| دقیقاً مشابه معماری Bale:
| تمام ارسال‌ها روی یک Page به صورت ترتیبی اجرا می‌شوند.
|--------------------------------------------------------------------------
*/

let actionQueue = Promise.resolve();

function prefix() {
    return '[RubikaService]';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePhone(value) {
    let v = String(value || '').trim().replace(/\D/g, '');

    if (v.startsWith('00')) {
        v = v.slice(2);
    }

    if (v.startsWith('98')) {
        v = '0' + v.slice(2);
    }

    if (!v.startsWith('0') && v.length === 10) {
        v = '0' + v;
    }

    return v;
}

function normalizePhoneForUrlOrLog(value) {
    const local = normalizePhone(value);

    if (local.startsWith('0')) {
        return '98' + local.slice(1);
    }

    return local;
}

function contactNameFromPhone(phone) {
    /*
     * فعلاً نام مخاطب را خود شماره قرار می‌دهیم.
     * این کار باعث می‌شود بدون وابستگی به نام واقعی شخص،
     * همان مخاطب ذخیره‌شده را در Search پیدا کنیم.
     */
    return normalizePhone(phone);
}

async function ensureSessionDirectory() {
    await fs.mkdir(SESSION_DIR, {
        recursive: true
    });
}

async function launchBrowser() {
    await ensureSessionDirectory();

    if (browser && !browser.connected) {
        browser = null;
        page = null;
    }

    if (!browser) {
        const launchOptions = {
            headless: false,
            userDataDir: SESSION_DIR,
            defaultViewport: {
                width: 1280,
                height: 800
            },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        };

        if (CHROME_PATH) {
            launchOptions.executablePath = CHROME_PATH;
        }

        console.log(
            `${prefix()} باز کردن Chrome | Session: ${SESSION_DIR}`
        );

        browser = await puppeteer.launch(launchOptions);

        browser.on('disconnected', () => {
            console.log(`${prefix()} Chrome بسته شد.`);

            browser = null;
            page = null;
        });
    }

    const pages = await browser.pages();

    if (pages.length > 0) {
        page = pages[0];
    } else {
        page = await browser.newPage();
    }

    await page.setViewport({
        width: 1280,
        height: 800
    });

    try {
        const origin = new URL(RUBIKA_URL).origin;
        await browser.defaultBrowserContext().overridePermissions(
            origin,
            ['clipboard-read', 'clipboard-write']
        );
    } catch (error) {
        console.warn(`${prefix()} ⚠️ دسترسی Clipboard قابل تنظیم نبود: ${error.message}`);
    }

    return page;
}

async function openRubikaWeb() {
    const currentPage = await launchBrowser();

    const currentUrl = String(currentPage.url() || '');

    if (!currentUrl.startsWith(RUBIKA_URL)) {
        console.log(
            `${prefix()} باز کردن Web Rubika...`
        );

        await currentPage.goto(RUBIKA_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        await sleep(3000);
    }

    return currentPage;
}

async function getPageText() {
    try {
        return await page.evaluate(
            () => document.body?.innerText || ''
        );
    } catch {
        return '';
    }
}

async function looksAuthenticated() {
    if (!page) return false;

    try {
        await sleep(800);

        const state = await page.evaluate(() => {
            const visible = el => {
                if (!el) return false;

                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();

                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    Number(style.opacity || 1) > 0 &&
                    rect.width > 0 &&
                    rect.height > 0
                );
            };

            const sidebarMenu = document.querySelector(
                '.sidebar-header__btn-container .btn-menu-toggle'
            );

            const animatedMenu = document.querySelector(
                '.sidebar-header__btn-container .animated-menu-icon'
            );

            const sidebarHeader = document.querySelector(
                '.sidebar-header__btn-container'
            );

            const addContactButton = document.querySelector(
                'button.rbico-add'
            );

            const visibleInputs = Array.from(
                document.querySelectorAll('input')
            ).filter(visible);

            const hasPhoneLoginInput = visibleInputs.some(input => {
                const value = [
                    input.placeholder,
                    input.getAttribute('aria-label'),
                    input.getAttribute('name'),
                    input.type
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();

                return (
                    value.includes('شماره موبایل') ||
                    value.includes('شماره تلفن') ||
                    value.includes('phone') ||
                    value.includes('mobile')
                );
            });

            const url = String(
                window.location.href || ''
            );

            return {
                url,
                sidebarMenu: visible(sidebarMenu),
                animatedMenu: visible(animatedMenu),
                sidebarHeader: visible(sidebarHeader),
                addContactButton: visible(addContactButton),
                hasPhoneLoginInput
            };
        });

        console.log(
            `${prefix()} 🔎 وضعیت احراز ورود:`,
            {
                url: state.url,
                sidebarMenu: state.sidebarMenu,
                animatedMenu: state.animatedMenu,
                sidebarHeader: state.sidebarHeader,
                addContactButton: state.addContactButton,
                phoneInput: state.hasPhoneLoginInput
            }
        );

        if (
            state.sidebarMenu ||
            state.animatedMenu ||
            state.sidebarHeader ||
            state.addContactButton
        ) {
            console.log(
                `${prefix()} ✅ حساب روبیکا وارد شده تشخیص داده شد.`
            );

            return true;
        }

        if (state.hasPhoneLoginInput) {
            console.log(
                `${prefix()} ⚠️ صفحه ورود روبیکا تشخیص داده شد.`
            );

            return false;
        }

        return false;
    } catch (error) {
        console.error(
            `${prefix()} ❌ خطا در تشخیص وضعیت ورود:`,
            error.message
        );

        return false;
    }
}

async function isVisible(element) {
    try {
        return await element.evaluate(el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || 1) > 0 &&
                rect.width > 0 &&
                rect.height > 0
            );
        });
    } catch {
        return false;
    }
}

async function elementText(element) {
    try {
        return await element.evaluate(
            el => (el.innerText || el.textContent || '').trim()
        );
    } catch {
        return '';
    }
}

async function clickVisibleSelector(
    selector,
    label = selector
) {
    if (!page) return false;

    const elements = await page.$$(selector);

    for (const element of elements) {
        if (!(await isVisible(element))) continue;

        try {
            await element.click();

            console.log(
                `${prefix()} 🖱️ کلیک: ${label}`
            );

            return true;
        } catch {
            try {
                await element.evaluate(el => el.click());

                console.log(
                    `${prefix()} 🖱️ کلیک: ${label}`
                );

                return true;
            } catch {
                // try next element
            }
        }
    }

    return false;
}

async function clickVisibleText(
    text,
    selectors = [
        'button',
        '[role="button"]',
        'a',
        'li',
        'div',
        'span'
    ]
) {
    if (!page) return false;

    const wanted = String(text || '').trim();

    for (const selector of selectors) {
        const elements = await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) continue;

            const value = await elementText(element);

            if (!value) continue;

            if (
                value === wanted ||
                value.includes(wanted)
            ) {
                try {
                    await element.click();

                    console.log(
                        `${prefix()} 🖱️ کلیک متن: "${wanted}"`
                    );

                    return true;
                } catch {
                    try {
                        await element.evaluate(
                            el => el.click()
                        );

                        console.log(
                            `${prefix()} 🖱️ کلیک متن: "${wanted}"`
                        );

                        return true;
                    } catch {
                        // continue
                    }
                }
            }
        }
    }

    return false;
}

async function waitForVisibleSelector(
    selector,
    timeout = UI_TIMEOUT
) {
    if (!page) {
        throw new Error(
            'صفحه روبیکا باز نیست.'
        );
    }

    await page.waitForSelector(selector, {
        visible: true,
        timeout
    });

    return page.$(selector);
}

async function getVisibleInputs() {
    if (!page) return [];

    const elements = await page.$$('input');
    const result = [];

    for (const element of elements) {
        if (await isVisible(element)) {
            result.push(element);
        }
    }

    return result;
}

async function getVisibleTextInputs() {
    const inputs = await getVisibleInputs();
    const result = [];

    for (const input of inputs) {
        try {
            const type = await input.evaluate(
                el =>
                    (
                        el.getAttribute('type') ||
                        'text'
                    ).toLowerCase()
            );

            if (
                type !== 'hidden' &&
                type !== 'checkbox' &&
                type !== 'radio' &&
                type !== 'button' &&
                type !== 'submit'
            ) {
                result.push(input);
            }
        } catch {
            // ignore
        }
    }

    return result;
}

async function getInputMeta(input) {
    try {
        return await input.evaluate(el => ({
            type: el.getAttribute('type') || '',
            placeholder:
                el.getAttribute('placeholder') || '',
            ariaLabel:
                el.getAttribute('aria-label') || '',
            name:
                el.getAttribute('name') || '',
            value:
                el.value || ''
        }));
    } catch {
        return {};
    }
}

async function clearAndType(input, value) {
    const text = String(value ?? '');

    if (!input) {
        throw new Error(
            'INPUT_NOT_FOUND: ورودی موردنظر پیدا نشد.'
        );
    }

    await input.click();
    await sleep(150);

    try {
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');

        await sleep(100);

        await page.keyboard.press('Backspace');
    } catch {
        try {
            await page.keyboard.up('Control');
        } catch {
            // ignore
        }

        await input.evaluate(el => {
            const prototype =
                Object.getPrototypeOf(el);

            const descriptor =
                Object.getOwnPropertyDescriptor(
                    prototype,
                    'value'
                );

            if (descriptor?.set) {
                descriptor.set.call(el, '');
            } else {
                el.value = '';
            }

            el.dispatchEvent(
                new Event('input', {
                    bubbles: true
                })
            );

            el.dispatchEvent(
                new Event('change', {
                    bubbles: true
                })
            );
        });
    }

    await sleep(150);

    try {
        await input.type(text, {
            delay: 40
        });
    } catch {
        await input.evaluate(
            (el, nextValue) => {
                const prototype =
                    Object.getPrototypeOf(el);

                const descriptor =
                    Object.getOwnPropertyDescriptor(
                        prototype,
                        'value'
                    );

                if (descriptor?.set) {
                    descriptor.set.call(
                        el,
                        nextValue
                    );
                } else {
                    el.value = nextValue;
                }

                el.dispatchEvent(
                    new Event('input', {
                        bubbles: true
                    })
                );

                el.dispatchEvent(
                    new Event('change', {
                        bubbles: true
                    })
                );
            },
            text
        );
    }

    await sleep(150);
}

async function clickHamburgerMenu() {
    if (!page) {
        throw new Error(
            'RUBIKA_PAGE_NOT_READY: صفحه روبیکا آماده نیست.'
        );
    }

    const selectors = [
        '.sidebar-header__btn-container .btn-menu-toggle',
        '.sidebar-header__btn-container .animated-menu-icon',
        'div.btn-menu-toggle[rb-menu]',
        'div[ripple].c-ripple.rp'
    ];

    for (const selector of selectors) {
        const elements = await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) continue;

            const box = await element.boundingBox();

            if (!box || box.y > 220) continue;

            try {
                await element.click();
            } catch {
                await element.evaluate(
                    el => el.click()
                );
            }

            console.log(
                `${prefix()} 🍔 منوی همبرگری کلیک شد.`
            );

            await sleep(800);

            return true;
        }
    }

    throw new Error(
        'HAMBURGER_NOT_FOUND: دکمه همبرگری روبیکا پیدا نشد.'
    );
}

async function openContacts() {
    if (!page) {
        throw new Error(
            'CONTACTS_PAGE_NOT_READY: صفحه روبیکا آماده نیست.'
        );
    }

    await clickHamburgerMenu();

    console.log(
        `${prefix()} 🍔 منوی همبرگری باز شد؛ در حال پیدا کردن گزینه «مخاطبین»...`
    );

    await sleep(1500);

    const contactTarget = await page.evaluate(() => {
        const wantedText = 'مخاطبین';

        const elements = Array.from(
            document.querySelectorAll(
                'span, div, li, a, button'
            )
        );

        const candidates = [];

        for (const element of elements) {
            const text =
                (
                    element.innerText ||
                    element.textContent ||
                    ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();

            if (text !== wantedText) {
                continue;
            }

            const rect =
                element.getBoundingClientRect();

            const style =
                window.getComputedStyle(element);

            if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                continue;
            }

            if (
                rect.bottom < 0 ||
                rect.top > window.innerHeight ||
                rect.right < 0 ||
                rect.left > window.innerWidth
            ) {
                continue;
            }

            candidates.push({
                element,
                rect: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                },
                tagName: element.tagName,
                className:
                    typeof element.className === 'string'
                        ? element.className
                        : ''
            });
        }

        if (!candidates.length) {
            return {
                success: false,
                reason: 'CONTACT_TEXT_NOT_FOUND'
            };
        }

        candidates.sort((a, b) => {
            const areaA =
                a.rect.width *
                a.rect.height;

            const areaB =
                b.rect.width *
                b.rect.height;

            return areaA - areaB;
        });

        const target = candidates[0];

        return {
            success: true,

            x:
                target.rect.x +
                target.rect.width / 2,

            y:
                target.rect.y +
                target.rect.height / 2,

            tagName: target.tagName,

            className:
                target.className,

            candidates: candidates.map(item => ({
                tagName: item.tagName,
                className: item.className,
                x: item.rect.x,
                y: item.rect.y,
                width: item.rect.width,
                height: item.rect.height
            }))
        };
    });

    if (!contactTarget.success) {
        console.log(
            `${prefix()} ❌ متن دقیق «مخاطبین» در منوی بازشده پیدا نشد.`
        );

        throw new Error(
            'CONTACTS_MENU_NOT_FOUND: عنصر دقیق «مخاطبین» پیدا نشد.'
        );
    }

    console.log(
        `${prefix()} 🎯 عنصر دقیق «مخاطبین» پیدا شد:`,
        {
            tag: contactTarget.tagName,
            class: contactTarget.className,
            x: contactTarget.x,
            y: contactTarget.y
        }
    );

    await page.mouse.click(
        contactTarget.x,
        contactTarget.y
    );

    console.log(
        `${prefix()} 🖱️ دقیقاً روی گزینه «مخاطبین» کلیک شد.`
    );

    await sleep(1500);

    console.log(
        `${prefix()} 👥 صفحه مخاطبین باز شد.`
    );

    return true;
}

async function clickAddContact() {
    const exactSelector =
        'button.btn-circle.btn-corner.z-depth-1.rbico-add.rp.is-visible';

    if (
        await clickVisibleSelector(
            exactSelector,
            'دکمه + افزودن مخاطب'
        )
    ) {
        await sleep(700);
        return;
    }

    const fallbackSelectors = [
        'button.rbico-add',
        '.rbico-add',
        '[class*="rbico-add"]'
    ];

    for (const selector of fallbackSelectors) {
        if (
            await clickVisibleSelector(
                selector,
                'دکمه + افزودن مخاطب'
            )
        ) {
            await sleep(700);
            return;
        }
    }

    throw new Error(
        'ADD_CONTACT_BUTTON_NOT_FOUND: دکمه + افزودن مخاطب پیدا نشد.'
    );
}

async function findNameInput(inputs) {
    for (const input of inputs) {
        const meta = await getInputMeta(input);

        const all = [
            meta.placeholder,
            meta.ariaLabel,
            meta.name
        ]
            .join(' ')
            .toLowerCase();

        if (
            all.includes('نام') ||
            all.includes('name')
        ) {
            return input;
        }
    }

    return inputs[0] || null;
}

async function findPhoneInput(
    inputs,
    nameInput
) {
    for (const input of inputs) {
        if (nameInput && input === nameInput) {
            continue;
        }

        const meta = await getInputMeta(input);

        const all = [
            meta.placeholder,
            meta.ariaLabel,
            meta.name,
            meta.type
        ]
            .join(' ')
            .toLowerCase();

        if (
            all.includes('شماره') ||
            all.includes('تلفن') ||
            all.includes('همراه') ||
            all.includes('phone') ||
            all.includes('mobile') ||
            meta.type === 'tel'
        ) {
            return input;
        }
    }

    return (
        inputs.find(
            input => input !== nameInput
        ) || null
    );
}

async function detectRubikaAccountMissing(timeoutMs = 5000) {
    const startedAt = Date.now();

    const indicators = [
        'مخاطب حساب کاربری روبیکا ندارد',
        'حساب کاربری روبیکا ندارد',
        'مخاطب حساب کاربری ندارد'
    ];

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const text = await getPageText();
            const normalized = String(text || '').replace(/\s+/g, ' ').trim();

            if (indicators.some(indicator => normalized.includes(indicator))) {
                console.log(`${prefix()} ❌ روبیکا اعلام کرد مخاطب حساب کاربری ندارد.`);
                return true;
            }
        } catch {
            // ignore and retry
        }

        await sleep(300);
    }

    return false;
}

async function refreshRubikaAfterMissingAccount() {
    try {
        console.log(`${prefix()} 🔄 حساب روبیکا وجود ندارد؛ صفحه در حال Refresh است...`);

        await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await sleep(1200);
        console.log(`${prefix()} 🔄 Refresh صفحه روبیکا انجام شد.`);
    } catch (error) {
        console.warn(`${prefix()} ⚠️ Refresh صفحه روبیکا ناموفق بود: ${error.message}`);
    }
}

async function addContact(name, phone) {
    const contactName =
        String(name ?? '').trim();

    const localPhone =
        normalizePhone(phone);

    if (!contactName) {
        throw new Error(
            'ADD_CONTACT_NAME_EMPTY: نام مخاطب خالی است.'
        );
    }

    if (!/^09\d{9}$/.test(localPhone)) {
        throw new Error(
            `ADD_CONTACT_PHONE_INVALID: شماره مخاطب معتبر نیست: ${phone}`
        );
    }

    console.log(
        `${prefix()} ➕ افزودن مخاطب | نام: ${contactName} | شماره: ${localPhone}`
    );

    await clickAddContact();

    await sleep(700);

    const inputs =
        await getVisibleTextInputs();

    if (inputs.length < 2) {
        const metas = [];

        for (const input of inputs) {
            metas.push(
                await getInputMeta(input)
            );
        }

        console.log(
            `${prefix()} 🔎 Inputهای قابل مشاهده:`,
            metas
        );

        throw new Error(
            `ADD_CONTACT_DIALOG_INPUTS_NOT_FOUND: تعداد inputهای قابل استفاده ${inputs.length} است.`
        );
    }

    const nameInput =
        await findNameInput(inputs);

    const phoneInput =
        await findPhoneInput(
            inputs,
            nameInput
        );

    if (!nameInput) {
        throw new Error(
            'ADD_CONTACT_NAME_INPUT_NOT_FOUND: کادر نام مخاطب پیدا نشد.'
        );
    }

    if (!phoneInput) {
        throw new Error(
            'ADD_CONTACT_PHONE_INPUT_NOT_FOUND: کادر شماره همراه پیدا نشد.'
        );
    }

    await nameInput.click();

    await clearAndType(
        nameInput,
        contactName
    );

    console.log(
        `${prefix()} ✍️ نام مخاطب وارد شد: ${contactName}`
    );

    await phoneInput.click();

    await clearAndType(
        phoneInput,
        localPhone
    );

    console.log(
        `${prefix()} 📱 شماره مخاطب وارد شد: ${localPhone}`
    );

    const clickedConfirm =
        await clickVisibleText(
            'افزودن مخاطب',
            [
                'button',
                '[role="button"]',
                'a'
            ]
        );

    if (!clickedConfirm) {
        const fallback =
            await clickVisibleText(
                'افزودن',
                [
                    'button',
                    '[role="button"]'
                ]
            );

        if (!fallback) {
            throw new Error(
                'ADD_CONTACT_CONFIRM_NOT_FOUND: دکمه «افزودن مخاطب» پیدا نشد.'
            );
        }
    }

    await sleep(500);

    const accountMissing =
        await detectRubikaAccountMissing();

    if (accountMissing) {
        await refreshRubikaAfterMissingAccount();

        return {
            success: false,
            permanentFailure: true,
            reason: 'RUBIKA_ACCOUNT_NOT_FOUND',
            contactName,
            phone: localPhone
        };
    }

    await sleep(1000);

    console.log(
        `${prefix()} ✅ دستور ذخیره مخاطب اجرا شد | ${contactName}`
    );

    return {
        success: true,
        contactName,
        phone: localPhone
    };
}

async function findContactSearchInput() {
    if (!page) return null;

    const inputs =
        await getVisibleTextInputs();

    for (const input of inputs) {
        const meta =
            await getInputMeta(input);

        const all = [
            meta.placeholder,
            meta.ariaLabel,
            meta.name
        ]
            .join(' ')
            .toLowerCase();

        if (
            all.includes('جستجو') ||
            all.includes('جست‌وجو') ||
            all.includes('search')
        ) {
            return input;
        }
    }

    for (const input of inputs) {
        const meta =
            await getInputMeta(input);

        if (
            meta.type !== 'tel' &&
            !String(
                meta.placeholder || ''
            ).includes('شماره')
        ) {
            return input;
        }
    }

    return null;
}

async function searchContactByName(
    contactName
) {
    const searchInput =
        await findContactSearchInput();

    if (!searchInput) {
        throw new Error(
            'CONTACT_SEARCH_INPUT_NOT_FOUND: کادر «جستجو» مخاطبین پیدا نشد.'
        );
    }

    await clearAndType(
        searchInput,
        contactName
    );

    console.log(
        `${prefix()} 🔎 جستجوی مخاطب ذخیره‌شده: ${contactName}`
    );

    await sleep(1200);

    return searchInput;
}

async function clickContactResult(
    contactName
) {
    const wanted =
        String(contactName).trim();

    const selectors = [
        '[role="button"]',
        'button',
        'li',
        'a',
        'div',
        'span'
    ];

    for (const selector of selectors) {
        const elements =
            await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) {
                continue;
            }

            const tag =
                await element.evaluate(
                    el =>
                        el.tagName.toLowerCase()
                );

            if (tag === 'input') {
                continue;
            }

            const text =
                await elementText(element);

            if (!text) continue;

            if (
                text === wanted ||
                text.includes(wanted)
            ) {
                const box =
                    await element.boundingBox();

                if (!box) continue;

                if (
                    box.width > 900 ||
                    box.height > 500
                ) {
                    continue;
                }

                try {
                    await element.click();

                    console.log(
                        `${prefix()} 👤 مخاطب پیدا شد و انتخاب شد: ${wanted}`
                    );

                    await sleep(1500);

                    return true;
                } catch {
                    try {
                        await element.evaluate(
                            el => el.click()
                        );

                        console.log(
                            `${prefix()} 👤 مخاطب پیدا شد و انتخاب شد: ${wanted}`
                        );

                        await sleep(1500);

                        return true;
                    } catch {
                        // continue
                    }
                }
            }
        }
    }

    return false;
}

async function openSavedContactChat(
    contactName
) {
    const wantedName =
        String(contactName || '').trim();

    if (!wantedName) {
        throw new Error(
            'CONTACT_NAME_EMPTY: نام مخاطب برای جستجو خالی است.'
        );
    }

    console.log(
        `${prefix()} 🔎 جستجوی مخاطب ذخیره‌شده: ${wantedName}`
    );

    /*
     * خیلی مهم:
     * این تابع فرض می‌کند همین الان داخل صفحه مخاطبین هستیم.
     *
     * بنابراین دوباره openContacts() اجرا نمی‌کنیم.
     */

    const searchInput =
        await findContactSearchInput();

    if (!searchInput) {
        throw new Error(
            'CONTACT_SEARCH_INPUT_NOT_FOUND: کادر «جستجو» مخاطبین پیدا نشد.'
        );
    }

    console.log(
        `${prefix()} 🔎 کادر جستجو پیدا شد.`
    );

    await clearAndType(
        searchInput,
        wantedName
    );

    console.log(
        `${prefix()} ✍️ نام مخاطب در جستجو وارد شد: ${wantedName}`
    );

    await sleep(1200);

    const clicked =
        await clickContactResult(
            wantedName
        );

    if (!clicked) {
        throw new Error(
            `CONTACT_RESULT_NOT_FOUND: مخاطب "${wantedName}" در نتایج جستجو پیدا نشد.`
        );
    }

    await sleep(1500);

    console.log(
        `${prefix()} 💬 چت مخاطب باز شد: ${wantedName}`
    );

    return {
        success: true,
        contactName: wantedName
    };
}

async function extractRubikaGuidFromCurrentChat() {
    if (!page) return null;

    const url =
        String(page.url() || '');

    /*
     * فرم لینک Web Rubika:
     * https://web.rubika.ir/#c=u0...
     */

    const hashMatch =
        url.match(/#c=([^&]+)/i);

    if (
        hashMatch &&
        hashMatch[1]
    ) {
        return decodeURIComponent(
            hashMatch[1]
        );
    }

    try {
        const hrefs =
            await page.$$eval(
                'a[href*="#c="], [data-peer-id], [data-user-guid]',
                elements =>
                    elements.map(el => ({
                        href:
                            el.getAttribute(
                                'href'
                            ) || '',

                        peerId:
                            el.getAttribute(
                                'data-peer-id'
                            ) || '',

                        userGuid:
                            el.getAttribute(
                                'data-user-guid'
                            ) || ''
                    }))
            );

        for (const item of hrefs) {
            const match =
                item.href.match(
                    /#c=([^&]+)/i
                );

            if (match?.[1]) {
                return decodeURIComponent(
                    match[1]
                );
            }

            if (item.peerId) {
                return item.peerId;
            }

            if (item.userGuid) {
                return item.userGuid;
            }
        }
    } catch {
        // ignore
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| Legacy helper
|--------------------------------------------------------------------------
| برای سازگاری با کدهای قبلی پروژه نگه داشته شده است.
|--------------------------------------------------------------------------
*/

async function openChatForSavedContact(
    phone
) {
    const contactName =
        contactNameFromPhone(phone);

    await openContacts();

    await searchContactByName(
        contactName
    );

    let clicked =
        await clickContactResult(
            contactName
        );

    if (!clicked) {
        console.log(
            `${prefix()} ⚠️ مخاطب در لیست پیدا نشد؛ وارد مرحله افزودن می‌شویم.`
        );

        await addContact(
            contactName,
            phone
        );

        await sleep(500);

        await openContacts();

        await searchContactByName(
            contactName
        );

        clicked =
            await clickContactResult(
                contactName
            );
    }

    if (!clicked) {
        throw new Error(
            `CONTACT_RESULT_NOT_FOUND: مخاطب ${contactName} بعد از ذخیره نیز در جستجوی مخاطبین پیدا نشد.`
        );
    }

    const guid =
        await extractRubikaGuidFromCurrentChat();

    if (!guid) {
        throw new Error(
            'RUBIKA_GUID_NOT_FOUND: چت باز شد اما GUID از URL/DOM قابل استخراج نبود.'
        );
    }

    console.log(
        `${prefix()} 💬 چت روبیکا باز شد | ${contactName} | GUID: ${guid}`
    );

    return {
        contactName,
        phone: normalizePhone(phone),
        rubikaGuid: guid
    };
}

async function findMessageBox() {
    if (!page) return null;

    console.log(
        `${prefix()} 🔎 در حال پیدا کردن کادر «پیام بنویسید»...`
    );

    const selectors = [
        'textarea',
        'div[contenteditable="true"]',
        '[role="textbox"]',
        'input[type="text"]'
    ];

    // ---------------------------------------------------------
    // مرحله اول:
    // پیدا کردن دقیق بر اساس placeholder / aria-label
    // ---------------------------------------------------------

    for (const selector of selectors) {
        const elements = await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) {
                continue;
            }

            const meta = await element.evaluate(el => ({
                placeholder:
                    el.getAttribute('placeholder') || '',

                ariaLabel:
                    el.getAttribute('aria-label') || '',

                title:
                    el.getAttribute('title') || '',

                dataPlaceholder:
                    el.getAttribute('data-placeholder') || '',

                role:
                    el.getAttribute('role') || '',

                className:
                    typeof el.className === 'string'
                        ? el.className
                        : '',

                contentEditable:
                    el.getAttribute('contenteditable') || '',

                tagName:
                    el.tagName.toLowerCase()
            }));

            const allText = [
                meta.placeholder,
                meta.ariaLabel,
                meta.title,
                meta.dataPlaceholder,
                meta.className
            ]
                .join(' ')
                .toLowerCase();

            if (
                allText.includes('پیام بنویسید') ||
                allText.includes('پیام بنویس') ||
                allText.includes('نوشتن پیام') ||
                allText.includes('message')
            ) {
                console.log(
                    `${prefix()} ✅ کادر دقیق «پیام بنویسید» پیدا شد.`,
                    meta
                );

                return element;
            }
        }
    }

    // ---------------------------------------------------------
    // مرحله دوم:
    // پیدا کردن textbox مربوط به چت
    // ---------------------------------------------------------

    for (const selector of selectors) {
        const elements = await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) {
                continue;
            }

            const meta = await element.evaluate(el => ({
                placeholder:
                    el.getAttribute('placeholder') || '',

                ariaLabel:
                    el.getAttribute('aria-label') || '',

                role:
                    el.getAttribute('role') || '',

                contentEditable:
                    el.getAttribute('contenteditable') || '',

                className:
                    typeof el.className === 'string'
                        ? el.className
                        : '',

                rect: (() => {
                    const r = el.getBoundingClientRect();

                    return {
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: r.height
                    };
                })()
            }));

            if (
                meta.role === 'textbox' ||
                meta.contentEditable === 'true'
            ) {
                // کادر پیام معمولاً در نیمه پایین صفحه قرار دارد.
                if (
                    meta.rect.y >
                    window.innerHeight * 0.45
                ) {
                    console.log(
                        `${prefix()} ✅ کادر textbox چت پیدا شد.`,
                        meta
                    );

                    return element;
                }
            }
        }
    }

    // ---------------------------------------------------------
    // مرحله سوم:
    // fallback برای textarea / contenteditable قابل مشاهده
    // ---------------------------------------------------------

    for (const selector of [
        'textarea',
        'div[contenteditable="true"]'
    ]) {
        const elements = await page.$$(selector);

        for (const element of elements) {
            if (!(await isVisible(element))) {
                continue;
            }

            const box =
                await element.boundingBox();

            if (!box) {
                continue;
            }

            // کادر پیام معمولاً پایین صفحه است.
            if (
                box.y >
                800 * 0.45
            ) {
                console.log(
                    `${prefix()} ✅ کادر پیام به صورت fallback پیدا شد.`
                );

                return element;
            }
        }
    }

    console.log(
        `${prefix()} ❌ کادر «پیام بنویسید» پیدا نشد.`
    );

    return null;
}

async function fillMessageBox(
    messageBox,
    text
) {
    const message = String(text || '');

    if (!messageBox) {
        throw new Error(
            'MESSAGE_BOX_NOT_FOUND: کادر پیام پیدا نشد.'
        );
    }

    if (!message) {
        throw new Error(
            'MESSAGE_FILL_EMPTY: متن پیام خالی است.'
        );
    }

    console.log(
        `${prefix()} 📝 آماده وارد کردن کل پیام به صورت یکجا...`
    );

    await messageBox.click();

    await sleep(300);

    try {
        await messageBox.focus();
    } catch {
        try {
            await messageBox.evaluate(
                el => el.focus()
            );
        } catch {
            // ignore
        }
    }

    await sleep(200);

    /*
     * ابتدا محتوای قبلی کادر را کامل پاک می‌کنیم.
     */
    try {
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');

        await sleep(100);

        await page.keyboard.press('Backspace');
    } catch {
        try {
            await page.keyboard.up('Control');
        } catch {
            // ignore
        }
    }

    await sleep(300);

    /*
     * نکته بسیار مهم:
     *
     * از keyboard.type استفاده نمی‌کنیم.
     *
     * چون اگر پیام چند خط داشته باشد، Enterهای داخل متن
     * ممکن است توسط Rubika به عنوان دستور ارسال تفسیر شوند.
     *
     * در اینجا کل متن را از Clipboard قرار می‌دهیم
     * و سپس فقط Paste می‌کنیم.
     */

    let pasted = false;

    try {
        await page.evaluate(
            async value => {
                await navigator.clipboard.writeText(value);
            },
            message
        );

        console.log(
            `${prefix()} 📋 کل پیام داخل Clipboard قرار گرفت.`
        );

        await sleep(300);

        /*
         * Paste کل پیام فقط با یک عملیات.
         */
        await page.keyboard.down('Control');
        await page.keyboard.press('V');
        await page.keyboard.up('Control');

        pasted = true;

        console.log(
            `${prefix()} 📋 کل پیام یکجا Paste شد.`
        );
    } catch (error) {
        console.log(
            `${prefix()} ⚠️ Clipboard Paste مستقیم ناموفق بود؛ روش جایگزین فعال می‌شود.`
        );
    }

    /*
     * اگر Clipboard در مرورگر اجازه نداد،
     * از Input.insertText استفاده می‌کنیم.
     *
     * insertText با keyboard.type فرق دارد و
     * متن را به صورت یک عملیات متنی وارد می‌کند؛
     * بنابراین Enterهای داخل پیام باعث ارسال جداگانه نمی‌شوند.
     */
    if (!pasted) {
        try {
            await page.keyboard.insertText(
                message
            );

            pasted = true;

            console.log(
                `${prefix()} 📋 کل پیام با insertText یکجا وارد شد.`
            );
        } catch (error) {
            console.log(
                `${prefix()} ⚠️ insertText هم ناموفق بود؛ fallback نهایی فعال می‌شود.`
            );

            /*
             * Fallback برای contenteditable
             */
            const isContentEditable =
                await messageBox.evaluate(
                    el =>
                        el.getAttribute(
                            'contenteditable'
                        ) === 'true'
                );

            const tagName =
                await messageBox.evaluate(
                    el =>
                        el.tagName.toLowerCase()
                );

            if (isContentEditable) {
                await messageBox.evaluate(
                    (el, value) => {
                        el.focus();

                        el.innerHTML = '';

                        /*
                         * متن را به صورت Text Node قرار می‌دهیم.
                         * از innerHTML استفاده نمی‌کنیم تا کاراکترهای
                         * پیام به عنوان HTML تفسیر نشوند.
                         */
                        const textNode =
                            document.createTextNode(
                                value
                            );

                        el.appendChild(
                            textNode
                        );

                        el.dispatchEvent(
                            new InputEvent(
                                'input',
                                {
                                    bubbles: true,
                                    inputType:
                                        'insertText',
                                    data: value
                                }
                            )
                        );
                    },
                    message
                );

                pasted = true;

                console.log(
                    `${prefix()} 📋 کل پیام در contenteditable قرار گرفت.`
                );
            } else if (
                tagName === 'textarea' ||
                tagName === 'input'
            ) {
                await messageBox.evaluate(
                    (el, value) => {
                        const prototype =
                            Object.getPrototypeOf(
                                el
                            );

                        const descriptor =
                            Object.getOwnPropertyDescriptor(
                                prototype,
                                'value'
                            );

                        if (descriptor?.set) {
                            descriptor.set.call(
                                el,
                                value
                            );
                        } else {
                            el.value = value;
                        }

                        el.dispatchEvent(
                            new Event(
                                'input',
                                {
                                    bubbles: true
                                }
                            )
                        );

                        el.dispatchEvent(
                            new Event(
                                'change',
                                {
                                    bubbles: true
                                }
                            )
                        );
                    },
                    message
                );

                pasted = true;

                console.log(
                    `${prefix()} 📋 کل پیام داخل input قرار گرفت.`
                );
            }
        }
    }

    if (!pasted) {
        throw new Error(
            'MESSAGE_FILL_FAILED: امکان Paste کردن کل پیام در کادر روبیکا وجود نداشت.'
        );
    }

    /*
     * کمی صبر می‌کنیم تا Vue/React/Rubika
     * مقدار جدید را در state خودش ثبت کند.
     */
    await sleep(800);

    /*
     * مقدار واقعی داخل کادر را می‌خوانیم.
     */
    const currentValue =
        await messageBox.evaluate(
            el => {
                const tag =
                    el.tagName.toLowerCase();

                if (
                    tag === 'textarea' ||
                    tag === 'input'
                ) {
                    return (
                        el.value || ''
                    );
                }

                return (
                    el.innerText ||
                    el.textContent ||
                    ''
                );
            }
        );

    /*
     * برای مقایسه، فقط CRLF را به LF تبدیل می‌کنیم.
     * خود خط‌های پیام حفظ می‌شوند.
     */
    const normalizeText =
        value =>
            String(value || '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .trim();

    const actual =
        normalizeText(currentValue);

    const expected =
        normalizeText(message);

    console.log(
        `${prefix()} 📝 متن موجود داخل کادر: ${JSON.stringify(actual)}`
    );


    if (!actual) {
        throw new Error(
            'MESSAGE_FILL_FAILED: بعد از Paste متن داخل کادر پیام قرار نگرفت.'
        );
    }

    console.log(
        `${prefix()} ✅ کل پیام داخل Composer قرار گرفت و آماده ارسال است.`
    );

    return true;
}

async function messageBoxIsEmpty(
    messageBox
) {
    try {
        return await messageBox.evaluate(
            el => {
                const tag =
                    el.tagName.toLowerCase();

                if (
                    tag === 'textarea' ||
                    tag === 'input'
                ) {
                    return !(
                        el.value || ''
                    ).trim();
                }

                return !(
                    el.innerText ||
                    el.textContent ||
                    ''
                ).trim();
            }
        );
    } catch {
        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Send Message
|--------------------------------------------------------------------------
| این بخش با Retry و Verification کار می‌کند.
|--------------------------------------------------------------------------
*/

async function sendMessageInCurrentChat(
    text
) {
    const message =
        String(text || '').trim();

    if (!message) {
        throw new Error(
            'EMPTY_MESSAGE: متن پیام خالی است.'
        );
    }

    console.log(
        `${prefix()} 📤 شروع ارسال پیام در چت فعلی...`
    );

    const messageBox =
        await findMessageBox();

    if (!messageBox) {
        throw new Error(
            'MESSAGE_BOX_NOT_FOUND: کادر «پیام بنویسید» در چت روبیکا پیدا نشد.'
        );
    }

    console.log(
        `${prefix()} ✅ کادر «پیام بنویسید» پیدا شد.`
    );

    /*
     * کل پیام را یکجا Paste می‌کنیم.
     */
    await fillMessageBox(
        messageBox,
        message
    );

    await sleep(700);

    /*
     * متن واقعی داخل Composer را می‌خوانیم.
     *
     * اینجا دیگر متن را با متن اصلی مقایسه نمی‌کنیم،
     * چون Rubika ممکن است Emoji یا بعضی کاراکترها را
     * هنگام Paste تغییر دهد.
     *
     * فقط مطمئن می‌شویم که Composer خالی نیست.
     */
    let beforeSend = '';

    try {
        beforeSend =
            await messageBox.evaluate(
                el => {
                    const tag =
                        el.tagName.toLowerCase();

                    if (
                        tag === 'textarea' ||
                        tag === 'input'
                    ) {
                        return (
                            el.value || ''
                        );
                    }

                    return (
                        el.innerText ||
                        el.textContent ||
                        ''
                    );
                }
            );
    } catch {
        beforeSend = '';
    }

    console.log(
        `${prefix()} 📝 متن آماده ارسال: ${JSON.stringify(beforeSend)}`
    );

    if (!String(beforeSend || '').trim()) {
        throw new Error(
            'MESSAGE_BEFORE_SEND_EMPTY: بعد از Paste، کادر پیام خالی است.'
        );
    }

    console.log(
        `${prefix()} ✅ متن داخل Composer قرار گرفته و آماده ارسال است.`
    );

    /*
     * خیلی مهم:
     *
     * دوباره روی خود Composer کلیک می‌کنیم
     * تا مطمئن شویم Keyboard Event دقیقاً
     * به همان کادر ارسال پیام می‌رسد.
     */
    await messageBox.click();

    await sleep(300);

    try {
        await messageBox.focus();
    } catch {
        try {
            await messageBox.evaluate(
                el => el.focus()
            );
        } catch {
            // ignore
        }
    }

    await sleep(300);

    /*
     * بررسی می‌کنیم که واقعاً Focus روی Composer باشد.
     */
    try {
        const focused =
            await page.evaluate(
                () => {
                    const active =
                        document.activeElement;

                    if (!active) {
                        return false;
                    }

                    return (
                        active.matches(
                            'textarea, input, [contenteditable="true"], [role="textbox"]'
                        ) ||
                        active.closest(
                            '[contenteditable="true"]'
                        ) !== null
                    );
                }
            );

        console.log(
            `${prefix()} 🎯 وضعیت Focus کادر پیام: ${focused ? 'فعال' : 'غیرفعال'}`
        );
    } catch {
        // ignore
    }

    /*
     * روش اول:
     *
     * Enter واقعی از طریق Puppeteer.
     */
    console.log(
        `${prefix()} ⌨️ ارسال پیام با Enter واقعی...`
    );

    await page.keyboard.press(
        'Enter'
    );

    console.log(
        `${prefix()} ⏳ منتظر ارسال پیام...`
    );

    await sleep(2000);

    /*
     * بررسی می‌کنیم Composer خالی شده یا نه.
     */
    let empty = false;

    try {
        empty =
            await messageBoxIsEmpty(
                messageBox
            );
    } catch {
        empty = false;
    }

    /*
     * اگر خالی شده باشد یعنی Rubika پیام را
     * قبول کرده و ارسال انجام شده است.
     */
    if (empty) {
        console.log(
            `${prefix()} 🎉 پیام با موفقیت ارسال شد.`
        );

        return true;
    }

    /*
     * اگر هنوز متن داخل کادر بود،
     * ممکن است Focus یا Keyboard Event
     * توسط UI گرفته نشده باشد.
     *
     * دوباره کادر فعلی را پیدا می‌کنیم.
     */
    console.log(
        `${prefix()} ⚠️ بعد از Enter کادر هنوز خالی نشده است.`
    );

    const currentBox =
        await findMessageBox();

    if (currentBox) {
        /*
         * دوباره Focus
         */
        await currentBox.click();

        await sleep(300);

        try {
            await currentBox.focus();
        } catch {
            try {
                await currentBox.evaluate(
                    el => el.focus()
                );
            } catch {
                // ignore
            }
        }

        await sleep(300);

        /*
         * روش دوم:
         * ارسال Keyboard Event مستقیماً روی Composer.
         *
         * این روش Enter را به خود عنصر
         * composer_rich_textarea می‌رساند.
         */
        console.log(
            `${prefix()} ⌨️ تلاش دوم برای ارسال Enter روی Composer...`
        );

        await currentBox.evaluate(
            el => {
                el.focus();

                const options = {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                };

                el.dispatchEvent(
                    new KeyboardEvent(
                        'keydown',
                        options
                    )
                );

                el.dispatchEvent(
                    new KeyboardEvent(
                        'keypress',
                        options
                    )
                );

                el.dispatchEvent(
                    new KeyboardEvent(
                        'keyup',
                        options
                    )
                );
            }
        );

        await sleep(2000);

        let secondEmpty = false;

        try {
            secondEmpty =
                await messageBoxIsEmpty(
                    currentBox
                );
        } catch {
            secondEmpty = false;
        }

        if (secondEmpty) {
            console.log(
                `${prefix()} 🎉 پیام با موفقیت ارسال شد.`
            );

            return true;
        }
    }

    /*
     * اگر هنوز خالی نشده، ارسال تأیید نشده است.
     */
    throw new Error(
        'MESSAGE_SEND_NOT_CONFIRMED: پیام داخل Composer باقی مانده و ارسال آن توسط Rubika تأیید نشد.'
    );
}

async function tryFillPhone(phone) {
    if (!page) return false;

    const inputs =
        await getVisibleTextInputs();

    for (const input of inputs) {
        const meta =
            await getInputMeta(input);

        const all = [
            meta.placeholder,
            meta.ariaLabel,
            meta.name,
            meta.type
        ]
            .join(' ')
            .toLowerCase();

        if (
            meta.type === 'tel' ||
            all.includes('phone') ||
            all.includes('mobile') ||
            all.includes('شماره')
        ) {
            await clearAndType(
                input,
                phone
            );

            return true;
        }
    }

    return false;
}

async function clickLoginButtonIfAvailable() {
    const labels = [
        'ورود',
        'ادامه',
        'تأیید',
        'Login',
        'Continue'
    ];

    for (const label of labels) {
        if (
            await clickVisibleText(
                label,
                [
                    'button',
                    '[role="button"]'
                ]
            )
        ) {
            await sleep(500);

            return true;
        }
    }

    return false;
}

/*
|--------------------------------------------------------------------------
| Public API
|--------------------------------------------------------------------------
*/

export async function initRubikaService() {
    if (initialized) {
        return;
    }

    initialized = true;

    console.log(
        `${prefix()} سرویس شخصی روبیکا در حال راه‌اندازی...`
    );

    console.log(
        `${prefix()} Web URL: ${RUBIKA_URL}`
    );

    console.log(
        `${prefix()} Session: ${SESSION_DIR}`
    );

    try {
        await openRubikaWeb();

        console.log(
            `${prefix()} ✅ مرورگر Chrome روبیکا باز شد.`
        );

        console.log(
            `${prefix()} 🌐 صفحه Web Rubika باز شد.`
        );
    } catch (error) {
        initialized = false;

        console.error(
            `${prefix()} ❌ خطا در راه‌اندازی Web Rubika:`,
            error.message
        );

        throw error;
    }
}

function ensureReady() {
    if (!initialized) {
        void initRubikaService();
    }
}

export async function getRubikaAuthStatus() {
    if (!initialized) {
        await initRubikaService();
    }

    try {
        await openRubikaWeb();

        const authenticated =
            await looksAuthenticated();

        return {
            authenticated,
            sessionDir: SESSION_DIR,
            browserOpen: Boolean(browser),
            url: page?.url() || ''
        };
    } catch (error) {
        return {
            authenticated: false,
            browserOpen: Boolean(browser),
            sessionDir: SESSION_DIR,
            error: error.message
        };
    }
}

export async function sendCode(phone) {
    if (!initialized) {
        await initRubikaService();
    }

    const normalized =
        normalizePhone(phone);

    if (!/^09\d{9}$/.test(normalized)) {
        throw new Error(
            'شماره موبایل معتبر نیست. نمونه: 0912xxxxxxxx'
        );
    }

    await openRubikaWeb();

    const alreadyLoggedIn =
        await looksAuthenticated();

    if (alreadyLoggedIn) {
        console.log(
            `${prefix()} حساب قبلاً وارد شده است | ${normalized}`
        );

        return {
            authenticated: true,
            phone: normalized,
            manualLoginRequired: false,
            message:
                'حساب روبیکا از قبل متصل است.'
        };
    }

    const filled =
        await tryFillPhone(
            normalized
        );

    const clicked =
        await clickLoginButtonIfAvailable();

    console.log(
        `${prefix()} آماده ورود حساب شخصی | شماره: ${normalized} | input=${filled} | button=${clicked}`
    );

    return {
        authenticated: false,
        phone: normalized,
        manualLoginRequired: true,
        phoneFilled: filled,
        loginButtonClicked: clicked,
        message:
            'Chrome باز شد. ورود و دریافت کد را داخل Web Rubika انجام دهید.'
    };
}

export async function verifyCode(
    phone,
    code
) {
    if (!initialized) {
        await initRubikaService();
    }

    const normalized =
        normalizePhone(phone);

    const otp =
        String(code || '').trim();

    if (!otp) {
        throw new Error(
            'کد تأیید خالی است.'
        );
    }

    await openRubikaWeb();

    await sleep(1000);

    const authenticated =
        await looksAuthenticated();

    if (!authenticated) {
        return {
            authenticated: false,
            phone: normalized,
            manualLoginRequired: true,
            message:
                'ورود هنوز توسط Web Rubika تأیید نشده است. کد را داخل پنجره Chrome وارد کنید.'
        };
    }

    return {
        authenticated: true,
        phone: normalized,
        manualLoginRequired: false,
        message:
            'حساب شخصی روبیکا با موفقیت متصل است.'
    };
}

export async function logoutRubika() {
    if (!initialized) {
        initialized = true;
    }

    try {
        if (browser) {
            await browser.close();
        }
    } catch {
        // ignore
    }

    browser = null;
    page = null;

    return {
        success: true,
        message:
            'Chrome بسته شد. برای حذف کامل Session باید پوشه rubika_session حذف شود.'
    };
}

export const rubikaLogout =
    logoutRubika;

export const logout =
    logoutRubika;

export const getAuthStatus =
    getRubikaAuthStatus;

/*
|--------------------------------------------------------------------------
| Create Contact
|--------------------------------------------------------------------------
| این تابع دقیقاً همان Flow موفق فعلی تو را حفظ می‌کند:
|
| openContacts()
|      ↓
| addContact()
|      ↓
| openSavedContactChat()
|
| و بعد از Add دوباره openContacts() نمی‌زند.
|--------------------------------------------------------------------------
*/

export async function createRubikaContact(
    name,
    phone
) {
    await openRubikaWeb();

    const authenticated =
        await looksAuthenticated();

    if (!authenticated) {
        throw new Error(
            'RUBIKA_NOT_AUTHENTICATED: حساب روبیکا وارد نشده است.'
        );
    }

    const contactName =
        String(name || '').trim();

    const localPhone =
        normalizePhone(phone);

    if (!contactName) {
        throw new Error(
            'CONTACT_NAME_EMPTY: نام مخاطب خالی است.'
        );
    }

    if (!localPhone) {
        throw new Error(
            'CONTACT_PHONE_INVALID: شماره موبایل نامعتبر است.'
        );
    }

    /*
     * فقط یک بار وارد صفحه مخاطبین می‌شویم.
     */

    await openContacts();

    /*
     * افزودن مخاطب
     */

    const savedContact =
        await addContact(
            contactName,
            localPhone
        );

    console.log(
        `${prefix()} ✅ مخاطب ذخیره شد: ${contactName}`
    );

    /*
     * همان‌جا هستیم؛ دوباره openContacts() نمی‌زنیم.
     */

    const chat =
        await openSavedContactChat(
            contactName
        );

    console.log(
        `${prefix()} 🎯 مخاطب پیدا شد و چت باز شد: ${contactName}`
    );

    return {
        ...savedContact,
        chatOpened: true,
        contactName: chat.contactName
    };
}

/*
|--------------------------------------------------------------------------
| Resolve Target For Campaign
|--------------------------------------------------------------------------
|
| این تابع مخصوص اتصال Campaign Worker به روبیکاست.
|
| ورودی:
|     شماره موبایل
|
| خروجی:
|     مخاطب آماده + چت باز شده + GUID
|
| نکته مهم:
| اگر مخاطب وجود داشته باشد:
|
| openContacts()
|    ↓
| search
|    ↓
| click
|
| اگر وجود نداشته باشد:
|
| openContacts()
|    ↓
| search
|    ↓
| addContact()
|    ↓
| openSavedContactChat()
|
| یعنی بعد از Add دوباره منوی مخاطبین را باز نمی‌کنیم.
|--------------------------------------------------------------------------
*/

export async function resolveRubikaTarget(target) {
    if (!initialized) {
        await initRubikaService();
    }

    const value = String(target || '').trim();

    if (!value) {
        throw new Error(
            'شماره مخاطب خالی است.'
        );
    }

    const phone = normalizePhone(value);

    if (!/^09\d{9}$/.test(phone)) {
        throw new Error(
            `شماره مخاطب معتبر نیست: ${value}`
        );
    }

    const contactName = contactNameFromPhone(phone);

    console.log(
        `${prefix()} 🔎 آماده‌سازی مخاطب کمپین روبیکا | شماره: ${phone}`
    );

    await openRubikaWeb();

    const authenticated = await looksAuthenticated();

    if (!authenticated) {
        throw new Error(
            'RUBIKA_NOT_AUTHENTICATED: حساب روبیکا وارد نشده است.'
        );
    }

    /*
     * ==========================================================
     * ترتیب صحیح کمپین:
     *
     * 1) ورود به مخاطبین
     * 2) ذخیره مخاطب
     * 3) صبر برای ثبت کامل مخاطب
     * 4) جستجوی مخاطب ذخیره‌شده
     * 5) کلیک روی مخاطب
     * 6) استخراج GUID
     *
     * خیلی مهم:
     * قبل از addContact() هیچ Search انجام نمی‌دهیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 👥 ورود به صفحه مخاطبین...`
    );

    await openContacts();

    console.log(
        `${prefix()} ➕ قبل از هر Search، مخاطب را ذخیره می‌کنیم | ${contactName} | ${phone}`
    );

    /*
     * مخاطب را مستقیماً ذخیره می‌کنیم.
     */
    const savedContact = await addContact(
        contactName,
        phone
    );

    if (savedContact?.reason === 'RUBIKA_ACCOUNT_NOT_FOUND') {
        const error = new Error(
            'RUBIKA_ACCOUNT_NOT_FOUND: مخاطب حساب کاربری روبیکا ندارد.'
        );
        error.code = 'RUBIKA_ACCOUNT_NOT_FOUND';
        error.permanentFailure = true;
        error.mobile = phone;
        throw error;
    }

    console.log(
        `${prefix()} ✅ مخاطب با موفقیت ذخیره شد | ${savedContact.contactName} | ${savedContact.phone}`
    );

    /*
     * کمی صبر می‌کنیم تا Web Rubika ثبت مخاطب را
     * کامل کند و لیست مخاطبین به‌روزرسانی شود.
     */
    await sleep(1200);

    /*
     * ==========================================================
     * خیلی مهم:
     *
     * اینجا دوباره openContacts() نمی‌زنیم.
     *
     * چون بعد از addContact هنوز در همان صفحه مخاطبین هستیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 🔎 حالا که مخاطب ذخیره شد، جستجو را شروع می‌کنیم | ${contactName}`
    );

    await openSavedContactChat(
        contactName
    );

    /*
     * بعد از کلیک روی نتیجه، باید داخل چت باشیم.
     */
    await sleep(1000);

    const guid =
        await extractRubikaGuidFromCurrentChat();

    if (!guid) {
        throw new Error(
            'RUBIKA_GUID_NOT_FOUND: مخاطب ذخیره و انتخاب شد اما GUID چت از URL/DOM قابل استخراج نبود.'
        );
    }

    console.log(
        `${prefix()} 🎯 مخاطب کمپین آماده ارسال است | ${phone} | ${contactName} | GUID: ${guid}`
    );

    return {
        success: true,
        phone,
        contactName,
        rubikaGuid: guid,
        alreadySaved: false
    };
}

export const resolveTarget =
    resolveRubikaTarget;
async function resolveRubikaTargetForImage(target) {
    if (!initialized) {
        await initRubikaService();
    }

    const value = String(target || '').trim();

    if (!value) {
        throw new Error(
            'شماره مخاطب خالی است.'
        );
    }

    const phone = normalizePhone(value);

    if (!/^09\d{9}$/.test(phone)) {
        throw new Error(
            `شماره مخاطب معتبر نیست: ${value}`
        );
    }

    const contactName = contactNameFromPhone(phone);

    console.log(
        `${prefix()} 🔎 آماده‌سازی مخاطب کمپین روبیکا برای عکس | شماره: ${phone}`
    );

    await openRubikaWeb();

    const authenticated = await looksAuthenticated();

    if (!authenticated) {
        throw new Error(
            'RUBIKA_NOT_AUTHENTICATED: حساب روبیکا وارد نشده است.'
        );
    }

    /*
     * ==========================================================
     * ترتیب صحیح کمپین:
     *
     * 1) ورود به مخاطبین
     * 2) ذخیره مخاطب
     * 3) صبر برای ثبت کامل مخاطب
     * 4) جستجوی مخاطب ذخیره‌شده
     * 5) کلیک روی مخاطب
     * 6) استخراج GUID
     *
     * خیلی مهم:
     * قبل از addContact() هیچ Search انجام نمی‌دهیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 👥 ورود به صفحه مخاطبین...`
    );

    await openContacts();

    console.log(
        `${prefix()} ➕ قبل از هر Search، مخاطب را ذخیره می‌کنیم | ${contactName} | ${phone}`
    );

    /*
     * مخاطب را مستقیماً ذخیره می‌کنیم.
     */
    const savedContact = await addContact(
        contactName,
        phone
    );

    if (savedContact?.reason === 'RUBIKA_ACCOUNT_NOT_FOUND') {
        const error = new Error(
            'RUBIKA_ACCOUNT_NOT_FOUND: مخاطب حساب کاربری روبیکا ندارد.'
        );
        error.code = 'RUBIKA_ACCOUNT_NOT_FOUND';
        error.permanentFailure = true;
        error.mobile = phone;
        throw error;
    }

    console.log(
        `${prefix()} ✅ مخاطب با موفقیت ذخیره شد | ${savedContact.contactName} | ${savedContact.phone}`
    );

    /*
     * کمی صبر می‌کنیم تا Web Rubika ثبت مخاطب را
     * کامل کند و لیست مخاطبین به‌روزرسانی شود.
     */
    await sleep(1200);

    /*
     * ==========================================================
     * خیلی مهم:
     *
     * اینجا دوباره openContacts() نمی‌زنیم.
     *
     * چون بعد از addContact هنوز در همان صفحه مخاطبین هستیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 🔎 حالا که مخاطب ذخیره شد، جستجو را شروع می‌کنیم | ${contactName}`
    );

    await openSavedContactChat(
        contactName
    );

    /*
     * بعد از کلیک روی نتیجه، باید داخل چت باشیم.
     */
    await sleep(1000);

    const guid =
        await extractRubikaGuidFromCurrentChat();

    if (!guid) {
        throw new Error(
            'RUBIKA_GUID_NOT_FOUND: مخاطب ذخیره و انتخاب شد اما GUID چت از URL/DOM قابل استخراج نبود.'
        );
    }

    console.log(
        `${prefix()} 🎯 مخاطب کمپین عکس آماده ارسال است | ${phone} | ${contactName} | GUID: ${guid}`
    );

    return {
        success: true,
        phone,
        contactName,
        rubikaGuid: guid,
        alreadySaved: false
    };
}


async function resolveRubikaTargetForImageCaption(target) {
    if (!initialized) {
        await initRubikaService();
    }

    const value = String(target || '').trim();

    if (!value) {
        throw new Error(
            'شماره مخاطب خالی است.'
        );
    }

    const phone = normalizePhone(value);

    if (!/^09\d{9}$/.test(phone)) {
        throw new Error(
            `شماره مخاطب معتبر نیست: ${value}`
        );
    }

    const contactName = contactNameFromPhone(phone);

    console.log(
        `${prefix()} 🔎 آماده‌سازی مخاطب کمپین روبیکا برای عکس + متن | شماره: ${phone}`
    );

    await openRubikaWeb();

    const authenticated = await looksAuthenticated();

    if (!authenticated) {
        throw new Error(
            'RUBIKA_NOT_AUTHENTICATED: حساب روبیکا وارد نشده است.'
        );
    }

    /*
     * ==========================================================
     * ترتیب صحیح کمپین:
     *
     * 1) ورود به مخاطبین
     * 2) ذخیره مخاطب
     * 3) صبر برای ثبت کامل مخاطب
     * 4) جستجوی مخاطب ذخیره‌شده
     * 5) کلیک روی مخاطب
     * 6) استخراج GUID
     *
     * خیلی مهم:
     * قبل از addContact() هیچ Search انجام نمی‌دهیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 👥 ورود به صفحه مخاطبین...`
    );

    await openContacts();

    console.log(
        `${prefix()} ➕ قبل از هر Search، مخاطب را ذخیره می‌کنیم | ${contactName} | ${phone}`
    );

    /*
     * مخاطب را مستقیماً ذخیره می‌کنیم.
     */
    const savedContact = await addContact(
        contactName,
        phone
    );

    if (savedContact?.reason === 'RUBIKA_ACCOUNT_NOT_FOUND') {
        const error = new Error(
            'RUBIKA_ACCOUNT_NOT_FOUND: مخاطب حساب کاربری روبیکا ندارد.'
        );
        error.code = 'RUBIKA_ACCOUNT_NOT_FOUND';
        error.permanentFailure = true;
        error.mobile = phone;
        throw error;
    }

    console.log(
        `${prefix()} ✅ مخاطب با موفقیت ذخیره شد | ${savedContact.contactName} | ${savedContact.phone}`
    );

    /*
     * کمی صبر می‌کنیم تا Web Rubika ثبت مخاطب را
     * کامل کند و لیست مخاطبین به‌روزرسانی شود.
     */
    await sleep(1200);

    /*
     * ==========================================================
     * خیلی مهم:
     *
     * اینجا دوباره openContacts() نمی‌زنیم.
     *
     * چون بعد از addContact هنوز در همان صفحه مخاطبین هستیم.
     * ==========================================================
     */

    console.log(
        `${prefix()} 🔎 حالا که مخاطب ذخیره شد، جستجو را شروع می‌کنیم | ${contactName}`
    );

    await openSavedContactChat(
        contactName
    );

    /*
     * بعد از کلیک روی نتیجه، باید داخل چت باشیم.
     */
    await sleep(1000);

    const guid =
        await extractRubikaGuidFromCurrentChat();

    if (!guid) {
        throw new Error(
            'RUBIKA_GUID_NOT_FOUND: مخاطب ذخیره و انتخاب شد اما GUID چت از URL/DOM قابل استخراج نبود.'
        );
    }

    console.log(
        `${prefix()} 🎯 مخاطب کمپین عکس + متن آماده ارسال است | ${phone} | ${contactName} | GUID: ${guid}`
    );

    return {
        success: true,
        phone,
        contactName,
        rubikaGuid: guid,
        alreadySaved: false
    };
}



/*
|--------------------------------------------------------------------------
| Media helpers
|--------------------------------------------------------------------------
*/

async function copyImageToClipboard(imagePath) {
    const rawPath = String(imagePath || '').trim();

    if (!rawPath) {
        throw new Error('MEDIA_PATH_EMPTY: مسیر تصویر خالی است.');
    }

    try {
        await fs.access(rawPath);
    } catch {
        throw new Error(`MEDIA_READ_FAILED: فایل تصویر پیدا نشد: ${rawPath}`);
    }

    if (process.platform !== 'win32') {
        throw new Error(
            'IMAGE_CLIPBOARD_UNSUPPORTED: این روش ارسال تصویر برای Windows طراحی شده است.'
        );
    }

    const absolutePath = path.resolve(rawPath);
    const encodedPath = Buffer
        .from(absolutePath, 'utf8')
        .toString('base64');

    /*
     * خیلی مهم:
     *
     * قبلاً مسیر فایل را با $args[0] به PowerShell می‌دادیم.
     * در powershell.exe + -Command این آرگومان همیشه به شکلی که انتظار
     * داریم وارد $args نمی‌شود و نتیجه می‌تواند این باشد که Clipboard اصلاً
     * پر نشود، در حالی که Node فقط یک خطای مبهم دریافت می‌کند.
     *
     * اینجا مسیر را داخل خود Script قرار می‌دهیم تا هیچ وابستگی به $args
     * وجود نداشته باشد. مسیر هم Base64 است تا فاصله، پرانتز و کاراکتر فارسی
     * هیچ مشکلی برای PowerShell ایجاد نکند.
     */
    const powershellScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$encoded = '${encodedPath}'
$path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
$image = $null
$bitmap = $null
try {
    if (-not [System.IO.File]::Exists($path)) {
        throw "Image file not found: $path"
    }

    $image = [System.Drawing.Image]::FromFile($path)
    $bitmap = New-Object System.Drawing.Bitmap($image)

    [System.Windows.Forms.Clipboard]::SetImage($bitmap)

    Write-Output ('OK|' + $bitmap.Width + '|' + $bitmap.Height)
}
finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
}
`;

    let lastError = null;

    /*
     * بعضی وقت‌ها Windows Clipboard برای چند صد میلی‌ثانیه در اختیار
     * برنامه دیگری است. بنابراین چند تلاش کوتاه انجام می‌دهیم.
     */
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            console.log(
                `${prefix()} 📋 کپی تصویر در Windows Clipboard | تلاش ${attempt}/4 | ${absolutePath}`
            );

            const { stdout, stderr } = await execFileAsync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-STA',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    powershellScript
                ],
                {
                    windowsHide: true,
                    timeout: 15000,
                    maxBuffer: 1024 * 1024
                }
            );

            const output = String(stdout || '').trim();
            const errorOutput = String(stderr || '').trim();

            if (!output.startsWith('OK|')) {
                throw new Error(
                    errorOutput ||
                    output ||
                    'PowerShell موفق شد اجرا شود اما Windows Clipboard تأیید نشد.'
                );
            }

            const parts = output.split('|');
            const width = Number(parts[1] || 0);
            const height = Number(parts[2] || 0);

            console.log(
                `${prefix()} ✅ تصویر در Windows System Clipboard قرار گرفت | ${width}x${height}`
            );

            return true;
        } catch (error) {
            lastError = error;

            console.warn(
                `${prefix()} ⚠️ کپی تصویر در Clipboard ناموفق بود | تلاش ${attempt}/4 | ${error.message}`
            );

            if (attempt < 4) {
                await sleep(500);
            }
        }
    }

    throw new Error(
        `IMAGE_CLIPBOARD_FAILED: قرار دادن تصویر در Windows Clipboard ناموفق بود: ${lastError?.message || 'خطای نامشخص'}`
    );
}


async function pasteImageIntoCurrentChat() {
    const messageBox = await findMessageBox();

    if (!messageBox) {
        throw new Error(
            'MESSAGE_BOX_NOT_FOUND: کادر چت برای Paste تصویر پیدا نشد.'
        );
    }

    await messageBox.click();

    await sleep(300);

    try {
        await messageBox.focus();
    } catch {
        // ignore
    }

    await sleep(300);

    await page.keyboard.down('Control');
    await page.keyboard.press('V');
    await page.keyboard.up('Control');

    console.log(
        `${prefix()} 🖼️ Ctrl+V روی چت اجرا شد؛ در حال انتظار برای Preview...`
    );

    await sleep(1000);

    try {
        await findImagePreviewRoot(3000);
        console.log(`${prefix()} ✅ تصویر بعد از Ctrl+V وارد Preview شد.`);
        return true;
    } catch {
        console.log(`${prefix()} ⚠️ Preview بعد از Paste اول پیدا نشد؛ Ctrl+V دوم اجرا می‌شود.`);
        await messageBox.click();
        await sleep(200);
        await page.keyboard.down('Control');
        await page.keyboard.press('V');
        await page.keyboard.up('Control');
        await sleep(1000);
    }
}

async function isVisibleInPage(element) {
    if (!element) return false;

    try {
        return await element.evaluate(el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || 1) > 0 &&
                rect.width > 0 &&
                rect.height > 0
            );
        });
    } catch {
        return false;
    }
}

async function findImagePreviewRoot(timeout = UI_TIMEOUT) {
    const startedAt = Date.now();

    const selectors = [
        '[role="dialog"]',
        '[aria-modal="true"]',
        '.modal',
        '.popup',
        '.dialog',
        '[class*="modal"]',
        '[class*="popup"]',
        '[class*="dialog"]'
    ];

    while (Date.now() - startedAt < timeout) {
        for (const selector of selectors) {
            const elements = await page.$$(selector);

            for (const element of elements) {
                if (!(await isVisibleInPage(element))) continue;

                const hasImage = await element.evaluate(root => {
                    return Array.from(root.querySelectorAll('img')).some(img => {
                        const style = window.getComputedStyle(img);
                        const rect = img.getBoundingClientRect();
                        return (
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            rect.width > 20 &&
                            rect.height > 20
                        );
                    });
                }).catch(() => false);

                const hasSend = await element.evaluate(root => {
                    return Array.from(
                        root.querySelectorAll('button, [role="button"], a, div, span')
                    ).some(el => {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        const text = (
                            el.innerText ||
                            el.textContent ||
                            el.getAttribute('aria-label') ||
                            el.getAttribute('title') ||
                            ''
                        ).replace(/\s+/g, ' ').trim();

                        return (
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            rect.width > 0 &&
                            rect.height > 0 &&
                            text.includes('ارسال')
                        );
                    });
                }).catch(() => false);

                if (hasImage && hasSend) {
                    console.log(`${prefix()} 🖼️ Preview عکس پیدا شد.`);
                    return element;
                }
            }
        }

        await sleep(250);
    }

    throw new Error(
        'IMAGE_PREVIEW_NOT_FOUND: Preview عکس بعد از Paste پیدا نشد.'
    );
}

async function findPreviewCaptionInput(previewRoot) {
    if (!previewRoot) return null;

    const selectors = [
        'textarea',
        'input',
        '[contenteditable="true"]',
        '[role="textbox"]'
    ];

    for (const selector of selectors) {
        const elements = await previewRoot.$$(selector);

        for (const element of elements) {
            if (!(await isVisibleInPage(element))) continue;

            const meta = await element.evaluate(el => ({
                placeholder: el.getAttribute('placeholder') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                title: el.getAttribute('title') || '',
                dataPlaceholder: el.getAttribute('data-placeholder') || '',
                name: el.getAttribute('name') || '',
                role: el.getAttribute('role') || '',
                contentEditable: el.getAttribute('contenteditable') || ''
            }));

            const all = [
                meta.placeholder,
                meta.ariaLabel,
                meta.title,
                meta.dataPlaceholder,
                meta.name
            ].join(' ').toLowerCase();

            if (
                all.includes('پیام بنویسید') ||
                all.includes('پیام بنویس') ||
                all.includes('نوشتن پیام') ||
                all.includes('caption') ||
                all.includes('description')
            ) {
                console.log(`${prefix()} 📝 فیلد «پیام بنویسید» داخل Preview پیدا شد.`);
                return element;
            }
        }
    }

    for (const selector of selectors) {
        const elements = await previewRoot.$$(selector);

        for (const element of elements) {
            if (!(await isVisibleInPage(element))) continue;

            const meta = await element.evaluate(el => {
                const rect = el.getBoundingClientRect();
                return {
                    rect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height
                    },
                    value: el.value || el.innerText || el.textContent || ''
                };
            });

            if (meta.rect.width > 100 && meta.rect.height > 15) {
                return element;
            }
        }
    }

    return null;
}

async function getPreviewSendButtonMeta(previewRoot) {
    if (!previewRoot) return null;

    const selectors = [
        'button',
        '[role="button"]',
        'a'
    ];

    for (const selector of selectors) {
        const elements = await previewRoot.$$(selector);

        for (const element of elements) {
            if (!(await isVisibleInPage(element))) continue;

            const meta = await element.evaluate(el => {
                const rect = el.getBoundingClientRect();
                const text = (
                    el.innerText ||
                    el.textContent ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    ''
                ).replace(/\s+/g, ' ').trim();

                return {
                    text,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    disabled: Boolean(
                        el.disabled ||
                        el.getAttribute('disabled') !== null ||
                        el.getAttribute('aria-disabled') === 'true'
                    ),
                    className:
                        typeof el.className === 'string'
                            ? el.className
                            : ''
                };
            });

            if (
                meta.text === 'ارسال' ||
                meta.text.includes('ارسال')
            ) {
                return {
                    element,
                    meta
                };
            }
        }
    }

    return null;
}

async function clickPreviewSendButton(previewRoot) {
    const target = await getPreviewSendButtonMeta(previewRoot);

    if (!target) {
        throw new Error(
            'IMAGE_SEND_BUTTON_NOT_FOUND: دکمه «ارسال» داخل Preview پیدا نشد.'
        );
    }

    const { element, meta } = target;

    console.log(
        `${prefix()} 🎯 دکمه ارسال Preview پیدا شد | ${meta.width}x${meta.height} | disabled=${meta.disabled}`
    );

    if (meta.disabled) {
        throw new Error(
            'IMAGE_SEND_BUTTON_DISABLED: دکمه «ارسال» Preview غیرفعال است.'
        );
    }

    /*
     * در نسخه قبلی فقط Element.click() استفاده می‌شد.
     * در Web Rubika بعضی وقت‌ها این کلیک DOM انجام می‌شود ولی
     * event واقعی Pointer/Mouse که کامپوننت Preview منتظر آن است
     * اجرا نمی‌شود. بنابراین اول کلیک واقعی در مرکز عنصر را انجام
     * می‌دهیم و فقط در صورت خطا fallbackهای DOM/keyboard را نگه می‌داریم.
     */
    const box = await element.boundingBox();

    if (!box) {
        throw new Error(
            'IMAGE_SEND_BUTTON_NOT_VISIBLE: مختصات دکمه ارسال Preview قابل دریافت نیست.'
        );
    }

    try {
        await page.mouse.move(
            box.x + box.width / 2,
            box.y + box.height / 2
        );
        await sleep(100);
        await page.mouse.down();
        await sleep(60);
        await page.mouse.up();

        console.log(
            `${prefix()} 🖱️ کلیک واقعی Mouse روی دکمه «ارسال» Preview انجام شد.`
        );
    } catch (mouseError) {
        console.log(
            `${prefix()} ⚠️ Mouse click ناموفق بود؛ fallback DOM فعال می‌شود | ${mouseError.message}`
        );

        try {
            await element.click();
        } catch {
            await element.evaluate(el => el.click());
        }

        console.log(
            `${prefix()} 🖱️ کلیک fallback روی دکمه «ارسال» Preview انجام شد.`
        );
    }

    return true;
}

async function isImagePreviewVisible(previewRoot = null) {
    if (previewRoot) {
        try {
            if (!(await isVisibleInPage(previewRoot))) {
                return false;
            }

            const state = await previewRoot.evaluate(root => {
                const images = Array.from(root.querySelectorAll('img'));
                const hasImage = images.some(img => {
                    const rect = img.getBoundingClientRect();
                    return rect.width > 20 && rect.height > 20;
                });

                const buttons = Array.from(
                    root.querySelectorAll('button, [role="button"], a')
                );

                const hasSend = buttons.some(btn => {
                    const rect = btn.getBoundingClientRect();
                    const text = (
                        btn.innerText ||
                        btn.textContent ||
                        btn.getAttribute('aria-label') ||
                        btn.getAttribute('title') ||
                        ''
                    ).replace(/\s+/g, ' ').trim();

                    return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        text.includes('ارسال')
                    );
                });

                return {
                    hasImage,
                    hasSend
                };
            });

            return state.hasImage && state.hasSend;
        } catch {
            return false;
        }
    }

    try {
        const roots = await page.$$(
            '[role="dialog"], [aria-modal="true"], .modal, .popup, .dialog, [class*="modal"], [class*="popup"], [class*="dialog"]'
        );

        for (const root of roots) {
            if (await isImagePreviewVisible(root)) {
                return true;
            }
        }
    } catch {
        // ignore
    }

    return false;
}

async function waitForImagePreviewClosed(
    previewRoot = null,
    timeout = 30000
) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
        const visible = await isImagePreviewVisible(previewRoot);

        if (!visible) {
            console.log(
                `${prefix()} ✅ Preview عکس بسته شد؛ ارسال تأیید شد.`
            );
            return true;
        }

        await sleep(300);
    }

    /*
     * اگر Preview هنوز وجود دارد، قبل از شکست نهایی وضعیت دکمه را
     * دوباره بررسی می‌کنیم. اگر دکمه هنوز فعال باشد یعنی احتمالاً
     * کلیک قبلی به event واقعی نرسیده است؛ یک کلیک واقعی دوم انجام
     * می‌دهیم. این کار فقط زمانی انجام می‌شود که دکمه هنوز active باشد.
     */
    if (previewRoot && await isVisibleInPage(previewRoot)) {
        const target = await getPreviewSendButtonMeta(previewRoot);

        if (target && !target.meta.disabled) {
            const box = await target.element.boundingBox();

            if (box) {
                console.log(
                    `${prefix()} ⚠️ Preview بعد از ۳۰ ثانیه هنوز فعال است؛ یک کلیک واقعی دوم برای تأیید ارسال انجام می‌شود.`
                );

                await page.mouse.click(
                    box.x + box.width / 2,
                    box.y + box.height / 2
                );

                const retryStartedAt = Date.now();

                while (Date.now() - retryStartedAt < 15000) {
                    if (!(await isImagePreviewVisible(previewRoot))) {
                        console.log(
                            `${prefix()} ✅ Preview بعد از کلیک دوم بسته شد؛ ارسال تأیید شد.`
                        );
                        return true;
                    }

                    await sleep(300);
                }
            }
        }
    }

    throw new Error(
        'IMAGE_SEND_NOT_CONFIRMED: بعد از کلیک «ارسال»، Preview بسته نشد.'
    );
}

async function sendCurrentImage(imagePath) {
    await fs.access(imagePath);

    console.log(`${prefix()} 🖼️ شروع ارسال تصویر در چت فعلی | ${imagePath}`);

    await pasteImageIntoCurrentChat();

    const previewRoot = await findImagePreviewRoot();

    await clickPreviewSendButton(previewRoot);
    await sleep(500);
    await waitForImagePreviewClosed(previewRoot, 30000);

    return true;
}

async function sendCurrentImageWithCaption(imagePath, caption) {
    const message = String(caption || '').trim();

    if (!message) {
        throw new Error('EMPTY_CAPTION: متن همراه عکس خالی است.');
    }

    await fs.access(imagePath);

    console.log(`${prefix()} 🖼️📝 شروع ارسال تصویر + متن در چت فعلی | ${imagePath}`);

    await pasteImageIntoCurrentChat();

    const previewRoot = await findImagePreviewRoot();
    const captionInput = await findPreviewCaptionInput(previewRoot);

    if (!captionInput) {
        throw new Error(
            'IMAGE_CAPTION_INPUT_NOT_FOUND: فیلد «پیام بنویسید» داخل Preview پیدا نشد.'
        );
    }

    await fillMessageBox(captionInput, message);

    const actualCaption = await captionInput.evaluate(el => {
        const tag = el.tagName.toLowerCase();
        return (
            tag === 'textarea' || tag === 'input'
                ? el.value || ''
                : el.innerText || el.textContent || ''
        );
    });

    if (!String(actualCaption || '').trim()) {
        throw new Error(
            'IMAGE_CAPTION_EMPTY_AFTER_PASTE: متن داخل فیلد Preview قرار نگرفت.'
        );
    }

    console.log(`${prefix()} 📝 متن داخل Preview قرار گرفت.`);

    await clickPreviewSendButton(previewRoot);
    await sleep(500);
    await waitForImagePreviewClosed(previewRoot, 30000);

    return true;
}

async function ensureChatUrl(guid) {
    await openRubikaWeb();

    const chatUrl = `${RUBIKA_URL}/#c=${encodeURIComponent(guid)}`;
    const currentUrl = String(page.url() || '');

    if (!currentUrl.includes(`#c=${guid}`)) {
        console.log(`${prefix()} 💬 باز کردن مستقیم چت | ${chatUrl}`);

        await page.goto(chatUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await sleep(1200);
    }
}

async function processRubikaImageActionInternal(mobile, imagePath) {
    if (!initialized) {
        await initRubikaService();
    }

    const phone = normalizePhone(mobile);
    const mediaPath = String(imagePath || '').trim();

    if (!/^09\d{9}$/.test(phone)) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'RECIPIENT_NOT_FOUND',
            error: `شماره موبایل روبیکا معتبر نیست: ${mobile}`,
            mobile: phone,
            type: 'image'
        };
    }

    if (!mediaPath) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'MEDIA_NOT_FOUND',
            error: 'مسیر فایل تصویر خالی است.',
            mobile: phone,
            type: 'image'
        };
    }

    try {
        await fs.access(mediaPath);
    } catch {
        return {
            success: false,
            permanentFailure: true,
            reason: 'MEDIA_NOT_FOUND',
            error: `فایل رسانه‌ای پیدا نشد: ${mediaPath}`,
            mobile: phone,
            imagePath: mediaPath,
            type: 'image'
        };
    }

    try {
        console.log(`${prefix()} 📋 آماده‌سازی تصویر در Clipboard قبل از ورود به چت | ${mediaPath}`);
        await copyImageToClipboard(mediaPath);
    } catch (clipboardError) {
        return {
            success: false,
            permanentFailure: false,
            reason: 'IMAGE_CLIPBOARD_FAILED',
            error: clipboardError.message,
            mobile: phone,
            imagePath: mediaPath,
            type: 'image'
        };
    }

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            console.log(`${prefix()} 🖼️ ارسال عکس | ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS}`);

            const target = await resolveRubikaTargetForImage(phone);

            if (!target?.rubikaGuid) {
                throw new Error('RUBIKA_GUID_NOT_FOUND: چت مقصد برای ارسال عکس آماده نشد.');
            }

            console.log(`${prefix()} 💬 چت عکس آماده ارسال | ${phone} | GUID: ${target.rubikaGuid}`);

            await ensureChatUrl(target.rubikaGuid);
            await sendCurrentImage(mediaPath);

            return {
                success: true,
                permanentFailure: false,
                reason: 'SENT',
                rubikaGuid: target.rubikaGuid,
                mobile: phone,
                imagePath: mediaPath,
                type: 'image'
            };
        } catch (error) {
            console.error(`${prefix()} ❌ ارسال عکس ناموفق | ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS} | ${error.message}`);

            if (error?.code === 'RUBIKA_ACCOUNT_NOT_FOUND' || error?.permanentFailure === true) {
                return {
                    success: false,
                    permanentFailure: true,
                    reason: error?.code || 'RUBIKA_ACCOUNT_NOT_FOUND',
                    error: error.message,
                    mobile: phone,
                    imagePath: mediaPath,
                    type: 'image'
                };
            }

            if (attempt < MAX_SEND_ATTEMPTS) {
                await sleep(RETRY_MS);
                continue;
            }

            return {
                success: false,
                permanentFailure: false,
                reason: 'SEND_FAILED',
                error: error.message,
                mobile: phone,
                imagePath: mediaPath,
                type: 'image'
            };
        }
    }
}

async function processRubikaImageCaptionActionInternal(mobile, imagePath, caption) {
    if (!initialized) {
        await initRubikaService();
    }

    const phone = normalizePhone(mobile);
    const mediaPath = String(imagePath || '').trim();
    const message = String(caption || '').trim();

    if (!/^09\d{9}$/.test(phone)) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'RECIPIENT_NOT_FOUND',
            error: `شماره موبایل روبیکا معتبر نیست: ${mobile}`,
            mobile: phone,
            type: 'image_caption'
        };
    }

    if (!mediaPath) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'MEDIA_NOT_FOUND',
            error: 'مسیر فایل تصویر خالی است.',
            mobile: phone,
            type: 'image_caption'
        };
    }

    if (!message) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'EMPTY_MESSAGE',
            error: 'متن همراه عکس خالی است.',
            mobile: phone,
            type: 'image_caption'
        };
    }

    try {
        await fs.access(mediaPath);
    } catch {
        return {
            success: false,
            permanentFailure: true,
            reason: 'MEDIA_NOT_FOUND',
            error: `فایل رسانه‌ای پیدا نشد: ${mediaPath}`,
            mobile: phone,
            imagePath: mediaPath,
            type: 'image_caption'
        };
    }

    try {
        console.log(`${prefix()} 📋 آماده‌سازی تصویر در Clipboard قبل از ورود به چت | ${mediaPath}`);
        await copyImageToClipboard(mediaPath);
    } catch (clipboardError) {
        return {
            success: false,
            permanentFailure: false,
            reason: 'IMAGE_CLIPBOARD_FAILED',
            error: clipboardError.message,
            mobile: phone,
            imagePath: mediaPath,
            type: 'image_caption'
        };
    }

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            console.log(`${prefix()} 🖼️📝 ارسال عکس + متن | ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS}`);

            const target = await resolveRubikaTargetForImageCaption(phone);

            if (!target?.rubikaGuid) {
                throw new Error('RUBIKA_GUID_NOT_FOUND: چت مقصد برای ارسال عکس + متن آماده نشد.');
            }

            console.log(`${prefix()} 💬 چت عکس + متن آماده ارسال | ${phone} | GUID: ${target.rubikaGuid}`);

            await ensureChatUrl(target.rubikaGuid);
            await sendCurrentImageWithCaption(mediaPath, message);

            return {
                success: true,
                permanentFailure: false,
                reason: 'SENT',
                rubikaGuid: target.rubikaGuid,
                mobile: phone,
                imagePath: mediaPath,
                caption: message,
                type: 'image_caption'
            };
        } catch (error) {
            console.error(`${prefix()} ❌ ارسال عکس + متن ناموفق | ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS} | ${error.message}`);

            if (error?.code === 'RUBIKA_ACCOUNT_NOT_FOUND' || error?.permanentFailure === true) {
                return {
                    success: false,
                    permanentFailure: true,
                    reason: error?.code || 'RUBIKA_ACCOUNT_NOT_FOUND',
                    error: error.message,
                    mobile: phone,
                    imagePath: mediaPath,
                    type: 'image_caption'
                };
            }

            if (attempt < MAX_SEND_ATTEMPTS) {
                await sleep(RETRY_MS);
                continue;
            }

            return {
                success: false,
                permanentFailure: false,
                reason: 'SEND_FAILED',
                error: error.message,
                mobile: phone,
                imagePath: mediaPath,
                caption: message,
                type: 'image_caption'
            };
        }
    }
}

/*
|--------------------------------------------------------------------------
| Prepare Chat For Campaign
|--------------------------------------------------------------------------
|
| این تابع شماره موبایل می‌گیرد و چت را آماده می‌کند.
|
| این همان چیزی است که Campaign Worker لازم دارد.
|--------------------------------------------------------------------------
*/

async function prepareRubikaChatForSending(
    phone
) {
    const target =
        await resolveRubikaTarget(
            phone
        );

    if (!target?.rubikaGuid) {
        throw new Error(
            'RUBIKA_GUID_NOT_FOUND: امکان آماده‌سازی چت روبیکا وجود ندارد.'
        );
    }

    return target;
}

/*
|--------------------------------------------------------------------------
| Internal Send
|--------------------------------------------------------------------------
|
| این تابع:
|
| 1. مخاطب را با mobile پیدا می‌کند
| 2. اگر لازم باشد ذخیره می‌کند
| 3. چت را باز می‌کند
| 4. همان text دریافت‌شده از Campaign Worker را ارسال می‌کند
| 5. نتیجه را برمی‌گرداند
|
| هیچ random message در اینجا وجود ندارد.
|--------------------------------------------------------------------------
*/

async function processRubikaActionInternal(
    mobile,
    text
) {
    if (!initialized) {
        await initRubikaService();
    }

    const phone =
        normalizePhone(mobile);

    const message =
        String(text || '').trim();

    if (!/^09\d{9}$/.test(phone)) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'RECIPIENT_NOT_FOUND',
            error:
                `شماره موبایل روبیکا معتبر نیست: ${mobile}`
        };
    }

    if (!message) {
        return {
            success: false,
            permanentFailure: true,
            reason: 'EMPTY_MESSAGE',
            error:
                'متن پیام خالی است.'
        };
    }

    for (
        let attempt = 1;
        attempt <= MAX_SEND_ATTEMPTS;
        attempt++
    ) {
        try {
            console.log(
                `${prefix()} 📤 ارسال کمپین روبیکا | شماره: ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS}`
            );

            /*
             * پیدا کردن / ساخت مخاطب و باز کردن چت
             */

            const target =
                await prepareRubikaChatForSending(
                    phone
                );

            console.log(
                `${prefix()} 💬 چت آماده ارسال | ${phone} | GUID: ${target.rubikaGuid}`
            );

            /*
             * اطمینان از اینکه صفحه هنوز روی همان چت است.
             */

            await openRubikaWeb();

            const guid =
                String(
                    target.rubikaGuid || ''
                ).trim();

            const currentUrl =
                String(
                    page.url() || ''
                );

            /*
             * اگر به هر دلیل صفحه از چت خارج شده بود،
             * مستقیماً همان چت را باز می‌کنیم.
             */

            if (
                !currentUrl.includes(
                    `#c=${guid}`
                )
            ) {
                const chatUrl =
                    `${RUBIKA_URL}/#c=${encodeURIComponent(guid)}`;

                console.log(
                    `${prefix()} 💬 باز کردن مستقیم چت | ${chatUrl}`
                );

                await page.goto(
                    chatUrl,
                    {
                        waitUntil:
                            'domcontentloaded',
                        timeout: 30000
                    }
                );

                await sleep(1200);
            }

            /*
             * ارسال همان پیامی که server.js
             * از Campaign انتخاب کرده است.
             */

            await sendMessageInCurrentChat(
                message
            );

            console.log(
                `${prefix()} 🎉 ارسال کمپین روبیکا موفق بود | ${phone}`
            );

            return {
                success: true,
                permanentFailure: false,
                reason: 'SENT',
                rubikaGuid: guid,
                mobile: phone,
                type: 'text'
            };
        } catch (error) {
            console.error(
                `${prefix()} ❌ ارسال ناموفق | شماره: ${phone} | تلاش ${attempt}/${MAX_SEND_ATTEMPTS} | ${error.message}`
            );

            if (
                error?.code === 'RUBIKA_ACCOUNT_NOT_FOUND' ||
                error?.permanentFailure === true
            ) {
                return {
                    success: false,
                    permanentFailure: true,
                    reason: error?.code || 'RUBIKA_ACCOUNT_NOT_FOUND',
                    error: error.message,
                    mobile: phone,
                    type: 'text'
                };
            }

            if (
                attempt <
                MAX_SEND_ATTEMPTS
            ) {
                console.log(
                    `${prefix()} 🔄 تلاش مجدد بعد از ${RETRY_MS}ms...`
                );

                await sleep(
                    RETRY_MS
                );

                continue;
            }

            return {
                success: false,
                permanentFailure: false,
                reason: 'SEND_FAILED',
                error: error.message,
                mobile: phone,
                type: 'text'
            };
        }
    }

    return {
        success: false,
        permanentFailure: false,
        reason: 'SEND_FAILED',
        error:
            'ارسال پیام ناموفق بود.',
        mobile: phone,
        type: 'text'
    };
}

/*
|--------------------------------------------------------------------------
| Public Campaign Send
|--------------------------------------------------------------------------
|
| این همان API است که server.js باید صدا بزند:
|
| processRubikaAction(
|     targetUser.mobile,
|     randomMessage.text
| )
|
| و Queue باعث می‌شود دو ارسال همزمان روی یک صفحه انجام نشوند.
|--------------------------------------------------------------------------
*/

export const processRubikaAction = (
    mobile,
    text
) => {
    const run =
        actionQueue.then(() =>
            processRubikaActionInternal(
                mobile,
                text
            )
        );

    /*
     * Queue را با خطای Promise قبلی متوقف نمی‌کنیم.
     */

    actionQueue =
        run.catch(() => { });

    return run;
};

/*
|--------------------------------------------------------------------------
| Image / Image + Text Campaign APIs
|--------------------------------------------------------------------------
*/

export const processRubikaImageAction = (
    mobile,
    imagePath
) => {
    const run = actionQueue.then(() =>
        processRubikaImageActionInternal(
            mobile,
            imagePath
        )
    );

    actionQueue = run.catch(() => { });

    return run;
};

export const processRubikaImageCaptionAction = (
    mobile,
    imagePath,
    caption
) => {
    const run = actionQueue.then(() =>
        processRubikaImageCaptionActionInternal(
            mobile,
            imagePath,
            caption
        )
    );

    actionQueue = run.catch(() => { });

    return run;
};

/*
 * Alias برای نام‌گذاری‌های احتمالی قبلی پروژه.
 */
export const processRubikaImageWithCaptionAction =
    processRubikaImageCaptionAction;

export function isRubikaConfigured() {
    return true;
}