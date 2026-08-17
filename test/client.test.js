'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('..');
const { createApiServer } = require('../server');

test('emits only new incoming messages and ignores duplicates', () => {
    const client = new Client({ pollIntervalMs: 0 });
    client.info = { id: 'self' };
    const received = [];
    const created = [];
    client.on('message', (message) => received.push(message));
    client.on('message_create', (message) => created.push(message));

    const oldItem = { item_id: '1', user_id: 'other', item_type: 'text', text: 'old', timestamp: '1000000' };
    const newItem = { item_id: '2', user_id: 'other', item_type: 'text', text: 'hello', timestamp: '2000000' };
    const ownItem = { item_id: '3', user_id: 'self', item_type: 'text', text: 'sent', timestamp: '3000000' };
    const thread = (items) => [{ thread_id: '99', users: [], items }];

    client._ingestThreads(thread([oldItem]), true);
    client._ingestThreads(thread([newItem, oldItem]));
    client._ingestThreads(thread([newItem, oldItem]));
    client._ingestThreads(thread([ownItem, newItem, oldItem]));

    assert.deepEqual(received.map((message) => message.body), ['hello']);
    assert.deepEqual(created.map((message) => message.body), ['hello', 'sent']);
    assert.equal(received[0].threadId, '99');
});

test('keeps the wwebjs-style Client, Chat and Message delegation contract', async () => {
    const client = new Client({ pollIntervalMs: 0 });
    client.info = { id: 'self' };
    client._fetchInbox = async () => [{
        thread_id: '99',
        users: [{ pk: 'other', username: 'friend' }],
        items: [{ item_id: '2', user_id: 'other', item_type: 'text', text: 'hello', timestamp: '2000000' }],
    }];
    client.sendMessage = async (target, body) => ({ target, body });

    const [chat] = await client.getChats();

    assert.equal(chat.id._serialized, '99');
    assert.deepEqual(await chat.sendMessage('from chat'), { target: '99', body: 'from chat' });
    assert.deepEqual(await chat.lastMessage.reply('from reply'), { target: '99', body: 'from reply' });
});

test('closes the login browser and relaunches it headless', async () => {
    const client = new Client();
    let closed = false;
    let launchedWith;
    client.pupBrowser = { close: async () => { closed = true; } };
    client._launchBrowser = async (options) => { launchedWith = options; };

    await client._restartHeadless();

    assert.equal(closed, true);
    assert.equal(launchedWith.headless, true);
    assert.equal(client._destroying, false);
});

test('delegates scheduling to Instagram with a normalized date', async () => {
    const client = new Client();
    const publishAt = new Date(Date.now() + 60 * 60 * 1000);
    client.publishPost = async (media, options) => ({ media, options });

    assert.deepEqual(
        await client.schedulePost('post.jpg', { caption: 'Teste', publishAt }),
        {
            media: 'post.jpg',
            options: { caption: 'Teste', publishAt: publishAt.toISOString() },
        },
    );
    await assert.rejects(
        client.schedulePost('post.jpg', { publishAt: Date.now() - 1000 }),
        /future date/,
    );
});

test('serves message, post and Reel endpoints', async (t) => {
    const calls = [];
    const client = {
        pupPage: {},
        info: { id: 'self' },
        initialize: async () => {
            client.pupPage = {};
            client.info = { id: 'self' };
        },
        logout: async () => {
            client.pupPage = null;
            client.info = null;
        },
        sendMessage: async (target, content) => ({
            id: { _serialized: 'message-1' },
            threadId: String(target),
            body: content,
            timestamp: 1,
        }),
        publishPost: async (media, options) => calls.push(['publish', media, options]) && { id: 'post-1' },
        schedulePost: async (media, options) => calls.push(['schedule', media, options]) && { id: 'post-2' },
    };
    const server = createApiServer(client);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    assert.deepEqual(await (await fetch(`${baseUrl}/health`)).json(), {
        ready: true,
        authentication: 'authenticated',
        accountId: 'self',
    });
    assert.equal((await (await fetch(`${baseUrl}/auth/status`)).json()).status, 'authenticated');
    assert.equal((await (await post('/messages', { target: '99', content: 'Olá' })).json()).id, 'message-1');
    assert.equal((await post('/posts', { media: 'photo.jpg', caption: 'Foto' })).status, 200);
    assert.equal((await post('/reels', {
        media: 'video.mp4',
        caption: 'Vídeo',
        publishAt: '2026-08-18T16:00:00+01:00',
    })).status, 200);
    assert.equal((await post('/reels', { media: 'photo.jpg' })).status, 400);
    client.schedulePost = async () => { throw new TypeError('publishAt must be a valid future date'); };
    assert.equal((await post('/posts', { media: 'photo.jpg', publishAt: '' })).status, 400);
    assert.deepEqual(calls, [
        ['publish', 'photo.jpg', { caption: 'Foto' }],
        ['schedule', 'video.mp4', {
            caption: 'Vídeo',
            publishAt: '2026-08-18T16:00:00+01:00',
        }],
    ]);
    assert.equal((await fetch(`${baseUrl}/auth/logout`, { method: 'POST' })).status, 200);
    assert.equal((await post('/messages', { target: '99', content: 'Olá' })).status, 409);
    assert.equal((await fetch(`${baseUrl}/auth/login`, { method: 'POST' })).status, 200);
    assert.equal((await (await fetch(`${baseUrl}/auth/status`)).json()).status, 'authenticated');
});
