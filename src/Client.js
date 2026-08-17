'use strict';

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const puppeteer = require('puppeteer');
const NoAuth = require('./authStrategies/NoAuth');
const Chat = require('./structures/Chat');
const Message = require('./structures/Message');
const { Events, InboxURL, LoginURL } = require('./Constants');

const DEFAULT_OPTIONS = {
    authTimeoutMs: 0,
    headlessAfterLogin: true,
    pollIntervalMs: 5000,
    inboxLimit: 20,
    igAppId: '936619743392459',
    puppeteer: {
        headless: false,
        defaultViewport: null,
        args: ['--window-size=520,760'],
    },
};

class Client extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options,
            puppeteer: { ...DEFAULT_OPTIONS.puppeteer, ...options.puppeteer },
        };
        this.authStrategy = options.authStrategy || new NoAuth();
        this.authStrategy.setup(this);
        this.pupBrowser = null;
        this.pupPage = null;
        this.info = null;
        this._requestHeaders = {};
        this._seenMessageIds = new Set();
        this._polling = false;
        this._destroying = false;
        this._pageQueue = Promise.resolve();
    }

    async initialize() {
        if (this.pupBrowser) throw new Error('Client is already initialized');

        this._destroying = false;
        try {
            await this.authStrategy.beforeBrowserInitialized();
            await this._launchBrowser({ ...this.options.puppeteer, headless: true });

            if (!(await this._isAuthenticated())) {
                if (this.options.puppeteer.headless === false) {
                    await this._restartBrowser(this.options.puppeteer);
                }
                this.emit(Events.LOGIN_REQUIRED, { url: LoginURL });
                await this.pupPage.goto(LoginURL, { waitUntil: 'domcontentloaded', timeout: 0 });
                await Promise.all((await this.pupBrowser.pages())
                    .filter((page) => page !== this.pupPage)
                    .map((page) => page.close()));

                try {
                    await this._waitForAuthentication();
                } catch (error) {
                    this.emit(Events.AUTHENTICATION_FAILURE, error.message);
                    throw error;
                }

                if (this.options.puppeteer.headless === false) {
                    await this.pupPage.setContent(`<!doctype html>
                        <html lang="pt"><meta charset="utf-8"><title>Instagram autenticado</title>
                        <style>
                            body { margin: 0; min-height: 100vh; display: grid; place-items: center;
                                font: 16px system-ui; color: #171717; background: #fff; text-align: center; }
                            b { display: grid; place-items: center; width: 52px; height: 52px; margin: auto;
                                border-radius: 50%; color: #fff; background: #16a34a; font-size: 28px; }
                            h1 { margin: 18px 0 8px; font-size: 22px; }
                            p { margin: 0; color: #666; }
                        </style><main><b>✓</b><h1>Autenticação concluída</h1>
                        <p>A janela vai fechar automaticamente.</p></main></html>`);
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
            } else if (!this.options.headlessAfterLogin && this.options.puppeteer.headless === false) {
                await this._restartBrowser(this.options.puppeteer);
            }

            if (this.options.headlessAfterLogin && this.options.puppeteer.headless === false) {
                await this._restartHeadless();
            }

            this.emit(Events.AUTHENTICATED);
            await this.pupPage.goto(InboxURL, { waitUntil: 'domcontentloaded', timeout: 0 });
            await this._waitForInbox();
            await this._loadSelf();
            await this._primeInbox();
            this._startPolling();
            this.emit(Events.READY);
            return this;
        } catch (error) {
            await this.destroy().catch(() => {});
            throw error;
        }
    }

    async _launchBrowser(options) {
        this._requestHeaders = {};
        let pages;
        if (process.platform === 'win32' && options.headless === false) {
            const port = await new Promise((resolve, reject) => {
                const server = net.createServer();
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    const { port } = server.address();
                    server.close(() => resolve(port));
                });
            });
            const child = spawn(
                await Promise.resolve(options.executablePath || puppeteer.executablePath()),
                (await puppeteer.defaultArgs(options)).concat(`--remote-debugging-port=${port}`),
                { detached: true, stdio: 'ignore', windowsHide: false },
            );
            child.unref();

            for (let attempt = 0; attempt < 100 && !this.pupBrowser; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const browser = await puppeteer.connect({
                    browserURL: `http://127.0.0.1:${port}`,
                    defaultViewport: options.defaultViewport,
                }).catch(() => null);
                if (!browser) continue;
                const browserPages = await browser.pages().catch(() => []);
                if (browserPages.length) {
                    this.pupBrowser = browser;
                    pages = browserPages;
                } else {
                    await browser.disconnect().catch(() => {});
                }
            }
            if (!this.pupBrowser) {
                child.kill();
                throw new Error('Visible Chromium failed to start');
            }
        } else {
            this.pupBrowser = await puppeteer.launch(options);
        }
        pages ||= await this.pupBrowser.pages();
        this.pupPage = pages[0] || (await this.pupBrowser.newPage());
        this.pupPage.setDefaultTimeout(30000);
        this.pupPage.on('request', (request) => this._captureHeaders(request));
        this.pupBrowser.on('disconnected', () => {
            if (!this._destroying) this.emit(Events.DISCONNECTED, 'BROWSER_CLOSED');
        });
    }

    async _restartHeadless() {
        await this._restartBrowser({ ...this.options.puppeteer, headless: true });
    }

    async _restartBrowser(options) {
        this._destroying = true;
        const browser = this.pupBrowser;
        this.pupBrowser = null;
        this.pupPage = null;
        try {
            await browser?.close();
        } finally {
            this._destroying = false;
        }
        await this._launchBrowser(options);
    }

    async getChats({ limit = this.options.inboxLimit } = {}) {
        const threads = await this._fetchInbox(limit);
        return threads.map((thread) => new Chat(this, this._normalizeThread(thread)));
    }

    async getChatById(threadId) {
        return new Chat(this, this._normalizeThread(await this._fetchThread(threadId)));
    }

    async getMessages(threadId, { limit = 20 } = {}) {
        const thread = await this._fetchThread(threadId, limit);
        return (thread.items || [])
            .slice(0, limit)
            .map((item) => new Message(this, this._normalizeMessage(item, threadId)));
    }

    publishPost(media, options = {}) {
        return this._runPageTask(() => this._publishPost(media, options)).catch((error) => {
            this.emit(Events.POST_ERROR, error, { media, ...options });
            throw error;
        });
    }

    async schedulePost(media, { caption = '', publishAt } = {}) {
        const scheduledAt = new Date(publishAt);
        if (!publishAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
            throw new TypeError('publishAt must be a valid future date');
        }
        if (scheduledAt - new Date() > 75 * 24 * 60 * 60 * 1000) {
            throw new RangeError('publishAt cannot be more than 75 days in the future');
        }
        return this.publishPost(media, { caption, publishAt: scheduledAt.toISOString() });
    }

    editPost(post, { caption } = {}) {
        return this._runPageTask(() => this._editPost(post, { caption })).catch((error) => {
            this.emit(Events.POST_ERROR, error, { post, caption });
            throw error;
        });
    }

    sendMessage(target, content) {
        return this._runPageTask(() => this._sendMessage(target, content));
    }

    async _sendMessage(target, content) {
        if (typeof content !== 'string' || !content.trim()) {
            throw new TypeError('Message content must be a non-empty string');
        }

        const sentAfter = Date.now() - 1000;
        const threadId = /^\d+$/.test(String(target))
            ? String(target)
            : await this._findOrOpenThreadByUsername(target);

        await this._openThread(threadId);
        const composer = await this.pupPage.waitForSelector(
            'textarea[placeholder], div[contenteditable="true"][role="textbox"]',
            { visible: true, timeout: 15000 },
        );
        await composer.click();
        await this.pupPage.keyboard.sendCharacter(content);
        await this.pupPage.keyboard.press('Enter');

        const message = await this._waitForSentMessage(threadId, content, sentAfter);
        if (message) {
            this._seenMessageIds.add(message.id._serialized);
            this.emit(Events.MESSAGE_CREATE, message);
            return message;
        }

        return new Message(this, {
            id: `local:${randomUUID()}`,
            threadId,
            body: content,
            type: 'text',
            timestamp: Math.floor(Date.now() / 1000),
            from: this.info?.id,
            fromMe: true,
            rawData: null,
        });
    }

    async destroy() {
        this._destroying = true;
        clearInterval(this._pollTimer);
        await this.pupBrowser?.close();
        this.pupBrowser = null;
        this.pupPage = null;
        this.info = null;
    }

    async logout() {
        await this.destroy();
        await this.authStrategy.logout();
        this._seenMessageIds.clear();
        this.emit(Events.DISCONNECTED, 'LOGOUT');
    }

    _runPageTask(task) {
        const result = this._pageQueue.then(task, task);
        this._pageQueue = result.catch(() => {});
        return result;
    }

    async _validatePost(media, caption) {
        if (typeof caption !== 'string' || caption.length > 2200) {
            throw new TypeError('caption must be a string with at most 2200 characters');
        }

        const mediaPaths = (Array.isArray(media) ? media : [media]).map((file) =>
            path.resolve(String(file)),
        );
        if (
            !mediaPaths.length ||
            mediaPaths.some((file) => !/\.(avif|jpe?g|png|heic|heif|mp4|mov)$/i.test(file))
        ) {
            throw new TypeError('media must contain AVIF, JPG, PNG, HEIC, HEIF, MP4 or MOV files');
        }

        for (const file of mediaPaths) {
            if (!(await fs.promises.stat(file).catch(() => undefined))?.isFile()) {
                throw new TypeError(`Media file was not found: ${file}`);
            }
        }
        return mediaPaths;
    }

    async _editPost(post, { caption } = {}) {
        if (!this.pupPage) throw new Error('Client is not initialized');
        if (typeof caption !== 'string' || caption.length > 2200) {
            throw new TypeError('caption must be a string with at most 2200 characters');
        }

        const reference = String(post ?? '').trim();
        const match = reference.match(
            /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i,
        );
        const kind = match?.[1]?.toLowerCase() || 'p';
        const shortcode = match?.[2] || (/^[A-Za-z0-9_-]+$/.test(reference) ? reference : null);
        if (!shortcode) throw new TypeError('post must be an Instagram post URL or shortcode');

        await this.pupPage.goto(`https://www.instagram.com/${kind}/${shortcode}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 0,
        });
        await this._clickControl(['Mais opções', 'More options']);
        await this._clickControl(['Editar', 'Edit'], '[role="menu"], [role="dialog"], body');

        const captionBox = await this.pupPage.waitForSelector(
            '[role="dialog"] textarea, [role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] [contenteditable="true"]',
            { visible: true, timeout: 15000 },
        );
        await captionBox.click({ clickCount: 3 });
        await this.pupPage.keyboard.down('Control');
        await this.pupPage.keyboard.press('A');
        await this.pupPage.keyboard.up('Control');
        await this.pupPage.keyboard.press('Backspace');
        if (caption) await this.pupPage.keyboard.sendCharacter(caption);

        await this._clickControl(
            ['Concluído', 'Done', 'Guardar', 'Save'],
            '[role="dialog"]',
            30000,
        );
        await this.pupPage.waitForFunction(
            (expected) => {
                const text = document.body.innerText.toLowerCase();
                const saved = /alterações guardadas|changes saved|post updated|publicação atualizada/.test(text);
                const visibleDialog = [...document.querySelectorAll('[role="dialog"]')]
                    .some((dialog) => dialog.getClientRects().length > 0);
                return saved || (!visibleDialog && document.body.innerText.includes(expected));
            },
            { timeout: 60000 },
            caption,
        );

        const result = {
            id: shortcode,
            reference: `${kind}/${shortcode}`,
            caption,
            status: 'edited',
            editedAt: new Date().toISOString(),
        };
        this.emit(Events.POST_EDITED, result);
        return result;
    }

    async _publishPost(media, { caption = '', publishAt } = {}) {
        if (!this.pupPage) throw new Error('Client is not initialized');
        const mediaPaths = await this._validatePost(media, caption);

        await this.pupPage.goto('https://www.instagram.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 0,
        });
        const dismissedNotifications = await this.pupPage.evaluate(() => {
            const dialog = [...document.querySelectorAll('[role="dialog"]')].find((candidate) =>
                /ativar notificações|turn on notifications/i.test(candidate.innerText),
            );
            const button = [...(dialog?.querySelectorAll('button, [role="button"]') || [])]
                .find((candidate) => /^(agora não|not now)$/i.test(candidate.textContent.trim()));
            button?.click();
            return Boolean(button);
        });
        if (dismissedNotifications) {
            await this.pupPage.waitForFunction(() =>
                ![...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
                    /ativar notificações|turn on notifications/i.test(dialog.innerText),
                ),
            );
        }
        await this._clickControl(['Nova publicação', 'New post', 'Create']);
        await this._clickControl(['Publicar', 'Post']);

        const fileInput = await this.pupPage.waitForSelector(
            '[role="dialog"] input[type="file"]',
            { timeout: 15000 },
        );
        if (mediaPaths.length > 1 && !(await fileInput.evaluate((input) => input.multiple))) {
            throw new Error('The current Instagram upload dialog does not accept a carousel');
        }
        await fileInput.uploadFile(...mediaPaths);

        const uploadStage = await this.pupPage.$eval(
            '[role="dialog"]',
            (dialog) => dialog.innerText,
        );
        await this._clickControl(['Seguinte', 'Next'], '[role="dialog"]', 60000);
        await this.pupPage.waitForFunction(
            (previous) => document.querySelector('[role="dialog"]')?.innerText !== previous,
            { timeout: 60000 },
            uploadStage,
        );
        await this._clickControl(['Seguinte', 'Next'], '[role="dialog"]', 60000);

        if (caption) {
            const captionBox = await this.pupPage.waitForSelector(
                '[role="dialog"] [contenteditable="true"][role="textbox"]',
                { visible: true, timeout: 15000 },
            );
            await captionBox.click();
            await this.pupPage.keyboard.sendCharacter(caption);
        }

        if (publishAt) await this._configureNativeSchedule(new Date(publishAt));
        await this._clickControl(
            publishAt ? ['Agendar', 'Schedule'] : ['Partilhar', 'Share'],
            '[role="dialog"]',
        );
        await this.pupPage.waitForFunction(
            () => {
                const text = document.body.innerText.toLowerCase();
                return (
                    text.includes('a tua publicação foi partilhada') ||
                    text.includes('your post has been shared') ||
                    text.includes('a tua publicação foi agendada') ||
                    text.includes('o teu conteúdo foi agendado') ||
                    text.includes('o teu reel foi agendado') ||
                    text.includes('your post has been scheduled') ||
                    text.includes('your reel has been scheduled')
                );
            },
            { timeout: 180000 },
        );

        const post = {
            id: randomUUID(),
            media: mediaPaths,
            caption,
            ...(publishAt
                ? { scheduledAt: new Date(publishAt).toISOString(), status: 'scheduled' }
                : { publishedAt: new Date().toISOString(), status: 'published' }),
        };
        this.emit(publishAt ? Events.POST_SCHEDULED : Events.POST_PUBLISHED, post);
        return post;
    }

    async _configureNativeSchedule(scheduledAt) {
        const settingsLabels = ['definições avançadas', 'advanced settings'];
        await this.pupPage.waitForFunction(
            (labels) => [...document.querySelectorAll('[role="dialog"] [role="button"]')]
                .some((element) => labels.some((label) => element.textContent.trim().toLowerCase().startsWith(label))),
            { timeout: 15000 },
            settingsLabels,
        );
        await this.pupPage.evaluate((labels) => {
            [...document.querySelectorAll('[role="dialog"] [role="button"]')]
                .find((element) => labels.some((label) =>
                    element.textContent.trim().toLowerCase().startsWith(label),
                ))?.click();
        }, settingsLabels);

        const scheduleLabels = ['agendar conteúdos', 'schedule content', 'schedule this post'];
        await this.pupPage.waitForFunction(
            (labels) => [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')]
                .some((input) => {
                    let parent = input.parentElement;
                    while (parent && parent.getAttribute('role') !== 'dialog') {
                        const text = parent.innerText?.trim().toLowerCase();
                        if (labels.some((label) => text?.startsWith(label))) return true;
                        parent = parent.parentElement;
                    }
                    return false;
                }),
            { timeout: 15000 },
            scheduleLabels,
        );
        await this.pupPage.evaluate((labels) => {
            const input = [...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')]
                .find((candidate) => {
                    let parent = candidate.parentElement;
                    while (parent && parent.getAttribute('role') !== 'dialog') {
                        const text = parent.innerText?.trim().toLowerCase();
                        if (labels.some((label) => text?.startsWith(label))) return true;
                        parent = parent.parentElement;
                    }
                    return false;
                });
            if (input?.getAttribute('aria-checked') !== 'true') input?.click();
        }, scheduleLabels);
        await this.pupPage.waitForSelector('[role="dialog"] input[role="spinbutton"]', {
            visible: true,
            timeout: 15000,
        });

        await this.pupPage.evaluate(() => {
            [...document.querySelectorAll('[role="dialog"] [role="button"]')]
                .find((element) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(element.textContent))?.click();
        });
        const now = new Date();
        const monthOffset =
            (scheduledAt.getFullYear() - now.getFullYear()) * 12 +
            scheduledAt.getMonth() - now.getMonth();
        for (let month = 0; month < monthOffset; month++) {
            await this.pupPage.evaluate(() => {
                [...document.querySelectorAll('button')]
                    .find((button) => /next month|mês seguinte/i.test(button.getAttribute('aria-label')))?.click();
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await this.pupPage.waitForFunction(
            (day) => [...document.querySelectorAll('[role="gridcell"]')]
                .some((cell) => cell.textContent.trim() === String(day) && cell.getAttribute('aria-disabled') !== 'true'),
            { timeout: 15000 },
            scheduledAt.getDate(),
        );
        await this.pupPage.evaluate((day) => {
            [...document.querySelectorAll('[role="gridcell"]')]
                .find((cell) => cell.textContent.trim() === String(day) && cell.getAttribute('aria-disabled') !== 'true')
                ?.click();
        }, scheduledAt.getDate());

        const timeInputs = await this.pupPage.$$('[role="dialog"] input[role="spinbutton"]');
        for (const [input, value] of timeInputs.map((input, index) => [
            input,
            index ? scheduledAt.getMinutes() : scheduledAt.getHours(),
        ])) {
            await input.click({ clickCount: 3 });
            await this.pupPage.keyboard.down('Control');
            await this.pupPage.keyboard.press('A');
            await this.pupPage.keyboard.up('Control');
            await this.pupPage.keyboard.type(String(value).padStart(2, '0'));
            await this.pupPage.keyboard.press('Tab');
        }
        const selectedTime = await this.pupPage.$$eval(
            '[role="dialog"] input[role="spinbutton"]',
            (inputs) => inputs.map((input) => Number(input.getAttribute('aria-valuenow'))),
        );
        if (
            selectedTime[0] !== scheduledAt.getHours() ||
            selectedTime[1] !== scheduledAt.getMinutes()
        ) {
            throw new Error('Instagram did not accept the scheduled time');
        }
    }

    async _clickControl(labels, scope = 'body', timeout = 15000) {
        const normalizedLabels = labels.map((label) => label.toLowerCase());
        await this.pupPage.waitForFunction(
            ({ labels, scope }) =>
                [...document.querySelectorAll(`${scope} a, ${scope} button, ${scope} [role="button"], ${scope} [role="menuitem"]`)].some(
                    (element) => {
                        const label = (element.textContent || '').trim().toLowerCase();
                        const svgLabel = element.querySelector('svg[aria-label]')
                            ?.getAttribute('aria-label')
                            ?.toLowerCase();
                        return (
                            element.getAttribute('aria-disabled') !== 'true' &&
                            !element.disabled &&
                            element.getClientRects().length > 0 &&
                            (labels.includes(label) || labels.includes(svgLabel))
                        );
                    },
                ),
            { timeout },
            { labels: normalizedLabels, scope },
        );
        await this.pupPage.evaluate(
            ({ labels, scope }) => {
                const element = [
                    ...document.querySelectorAll(`${scope} a, ${scope} button, ${scope} [role="button"], ${scope} [role="menuitem"]`),
                ].find((candidate) => {
                    const label = (candidate.textContent || '').trim().toLowerCase();
                    const svgLabel = candidate.querySelector('svg[aria-label]')
                        ?.getAttribute('aria-label')
                        ?.toLowerCase();
                    return (
                        candidate.getAttribute('aria-disabled') !== 'true' &&
                        !candidate.disabled &&
                        candidate.getClientRects().length > 0 &&
                        (labels.includes(label) || labels.includes(svgLabel))
                    );
                });
                element.click();
            },
            { labels: normalizedLabels, scope },
        );
    }

    async _isAuthenticated() {
        return (await this.pupPage.cookies('https://www.instagram.com/')).some(
            (cookie) => cookie.name === 'sessionid' && cookie.value,
        );
    }

    async _waitForAuthentication() {
        const started = Date.now();

        while (this.pupBrowser?.connected) {
            if (await this._isAuthenticated()) return;
            if (this.options.authTimeoutMs && Date.now() - started >= this.options.authTimeoutMs) {
                throw new Error('Instagram login timed out');
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new Error('Login popup was closed before authentication');
    }

    async _waitForInbox() {
        await this.pupPage.waitForFunction(
            () => location.pathname.startsWith('/direct/') || document.querySelector('a[href^="/direct/"]'),
            { timeout: 30000 },
        );
    }

    async _loadSelf() {
        const cookies = await this.pupPage.cookies('https://www.instagram.com/');
        this.info = {
            id: cookies.find((cookie) => cookie.name === 'ds_user_id')?.value,
        };
    }

    _captureHeaders(request) {
        if (!request.url().includes('instagram.com/')) return;
        const headers = request.headers();

        for (const name of ['x-ig-app-id', 'x-asbd-id', 'x-instagram-ajax']) {
            if (headers[name]) this._requestHeaders[name] = headers[name];
        }
    }

    async _api(path) {
        if (!this.pupPage) throw new Error('Client is not initialized');

        const result = await this.pupPage.evaluate(
            async ({ path, headers, fallbackAppId }) => {
                const response = await fetch(path, {
                    credentials: 'include',
                    headers: {
                        Accept: '*/*',
                        'X-IG-App-ID': headers['x-ig-app-id'] || fallbackAppId,
                        ...(headers['x-asbd-id'] ? { 'X-ASBD-ID': headers['x-asbd-id'] } : {}),
                        ...(headers['x-instagram-ajax']
                            ? { 'X-Instagram-AJAX': headers['x-instagram-ajax'] }
                            : {}),
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                });
                return { status: response.status, text: await response.text() };
            },
            { path, headers: this._requestHeaders, fallbackAppId: this.options.igAppId },
        );

        const text = result.text.replace(/^for \(;;\);/, '');
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(`Instagram returned non-JSON data (${result.status})`);
        }

        if (result.status >= 400 || data.status === 'fail') {
            throw new Error(data.message || `Instagram request failed (${result.status})`);
        }
        return data;
    }

    async _fetchInbox(limit = this.options.inboxLimit) {
        const query = new URLSearchParams({
            visual_message_return_type: 'unseen',
            thread_message_limit: '10',
            limit: String(limit),
        });
        return (await this._api(`/api/v1/direct_v2/inbox/?${query}`)).inbox?.threads || [];
    }

    async _fetchThread(threadId, limit = 20) {
        if (!/^\d+$/.test(String(threadId))) throw new TypeError('Invalid Instagram thread id');
        const query = new URLSearchParams({
            visual_message_return_type: 'unseen',
            direction: 'older',
            limit: String(limit),
        });
        const data = await this._api(`/api/v1/direct_v2/threads/${threadId}/?${query}`);
        if (!data.thread) throw new Error(`Instagram thread ${threadId} was not found`);
        return data.thread;
    }

    _normalizeThread(thread) {
        const threadId = String(thread.thread_v2_id || thread.thread_id);
        const users = (thread.users || []).map((user) => ({
            id: String(user.pk || user.pk_id || user.id),
            username: user.username,
            name: user.full_name,
            profilePicUrl: user.profile_pic_url,
        }));
        const lastItem = thread.items?.[0];

        return {
            threadId,
            name: thread.thread_title || users.map((user) => user.username).filter(Boolean).join(', '),
            users,
            unreadCount: Number(thread.read_state) || 0,
            timestamp: lastItem ? this._timestamp(lastItem.timestamp) : 0,
            lastMessage: lastItem ? this._normalizeMessage(lastItem, threadId) : undefined,
            rawData: thread,
        };
    }

    _normalizeMessage(item, threadId) {
        const from = String(item.user_id || item.sender_id || '');
        const fromMe = Boolean(this.info?.id && from === String(this.info.id));
        const type = item.item_type || 'unknown';

        return {
            id: String(item.item_id || item.id || item.client_context || randomUUID()),
            threadId: String(threadId),
            body:
                item.text ||
                item.link?.text ||
                item.reel_share?.text ||
                item.media_share?.caption?.text ||
                (type === 'text' ? '' : `[${type}]`),
            type,
            timestamp: this._timestamp(item.timestamp),
            from,
            to: fromMe ? undefined : this.info?.id,
            fromMe,
            rawData: item,
        };
    }

    _timestamp(value) {
        const timestamp = Number(value) || 0;
        return Math.floor(timestamp > 10_000_000_000 ? timestamp / 1_000_000 : timestamp);
    }

    async _primeInbox() {
        this._ingestThreads(await this._fetchInbox(), true);
    }

    _startPolling() {
        if (!this.options.pollIntervalMs) return;
        this._pollTimer = setInterval(() => this._pollInbox(), this.options.pollIntervalMs);
    }

    async _pollInbox() {
        if (this._polling || !this.pupPage) return;
        this._polling = true;

        try {
            if (!(await this._isAuthenticated())) {
                clearInterval(this._pollTimer);
                this.emit(Events.DISCONNECTED, 'LOGOUT');
                return;
            }
            this._ingestThreads(await this._fetchInbox());
        } catch (error) {
            this.emit(Events.POLL_ERROR, error);
        } finally {
            this._polling = false;
        }
    }

    _ingestThreads(threads, initial = false) {
        for (const thread of threads) {
            const threadId = String(thread.thread_v2_id || thread.thread_id);

            for (const item of [...(thread.items || [])].reverse()) {
                const data = this._normalizeMessage(item, threadId);
                if (this._seenMessageIds.has(data.id)) continue;
                this._seenMessageIds.add(data.id);
                if (initial) continue;

                const message = new Message(this, data);
                this.emit(Events.MESSAGE_CREATE, message);
                if (!message.fromMe) this.emit(Events.MESSAGE_RECEIVED, message);
            }
        }

        // ponytail: bounded recent-ID cache; use persistent per-account cursors if long-running history matters.
        while (this._seenMessageIds.size > 5000) {
            this._seenMessageIds.delete(this._seenMessageIds.values().next().value);
        }
    }

    async _findOrOpenThreadByUsername(target) {
        const username = String(target).replace(/^@/, '');
        if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) throw new TypeError('Invalid Instagram username');

        const existing = (await this.getChats()).find((chat) =>
            chat.users.some((user) => user.username?.toLowerCase() === username.toLowerCase()),
        );
        if (existing) return existing.id._serialized;

        await this.pupPage.goto(`https://www.instagram.com/${username}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 0,
        });
        const clicked = await this.pupPage.evaluate(() => {
            const labels = ['message', 'mensagem', 'enviar mensagem', 'mensaje'];
            const candidates = document.querySelectorAll('button, [role="button"], a');
            const button = [...candidates].find((element) =>
                labels.includes((element.textContent || '').trim().toLowerCase()),
            );
            button?.click();
            return Boolean(button);
        });
        if (!clicked) throw new Error(`Message button was not found on @${username}`);

        await this.pupPage.waitForFunction(() => /\/direct\/t\/\d+/.test(location.pathname), {
            timeout: 15000,
        });
        return this.pupPage.url().match(/\/direct\/t\/(\d+)/)?.[1];
    }

    async _openThread(threadId) {
        if (!/^\d+$/.test(String(threadId))) throw new TypeError('Invalid Instagram thread id');
        if (!this.pupPage.url().includes(`/direct/t/${threadId}`)) {
            await this.pupPage.goto(`https://www.instagram.com/direct/t/${threadId}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 0,
            });
        }
    }

    async _waitForSentMessage(threadId, content, sentAfter) {
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const item = (await this._fetchThread(threadId, 20)).items?.find((candidate) => {
                    const message = this._normalizeMessage(candidate, threadId);
                    return message.fromMe && message.body === content && message.timestamp * 1000 >= sentAfter;
                });
                if (item) return new Message(this, this._normalizeMessage(item, threadId));
            } catch {
                // The UI send succeeded; polling will retry the read path.
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return undefined;
    }
}

module.exports = Client;
