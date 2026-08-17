# instagram-web.js

An unofficial Instagram Web client for Node.js, inspired by the developer experience of
[`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js). It lets you manage messages,
publish Posts and Reels, and use Instagram's native scheduling through a Puppeteer-controlled
browser — without using the Meta API.

> [!WARNING]
> This project controls Instagram Web and is not official or affiliated with Meta or Instagram.
> Website changes may break features, and automation may result in account restrictions. Only
> use accounts you control, and do not use this project for spam.

## Features

- Manual login on the official Instagram page, including 2FA and security challenges.
- Persistent sessions with `LocalAuth`; passwords are never stored in the code.
- Send and receive text messages.
- An API similar to `whatsapp-web.js`, with `Client`, `Chat`, `Message`, and events.
- Publish images, videos, carousels, and Reels immediately.
- Use Instagram's native Post and Reel scheduling with professional accounts.
- A ready-to-use local HTTP API for `curl`, PowerShell, or any other application.

## Installation

Requires [Node.js](https://nodejs.org/) 22.12 or later.

### Clone and start the server

```bash
git clone https://github.com/gonbenvindo-debug/instagram-web.js.git
cd instagram-web.js
npm install
npm start
```

The server will be available at `http://127.0.0.1:3000`.

### Install as a Git dependency

```bash
npm install github:gonbenvindo-debug/instagram-web.js
```

Then import the client:

```js
const { Client, LocalAuth } = require('instagram-web.js');
```

## Quick start — HTTP API

Keep `npm start` running and execute the following examples in another terminal.

### 1. Log in

```bash
curl -X POST http://127.0.0.1:3000/auth/login
```

On first use, a window opens on the official Instagram login page. After authentication, the
window closes and Chromium continues running in the background. On subsequent runs, the saved
session is reused.

Check the authentication status:

```bash
curl http://127.0.0.1:3000/auth/status
```

Response:

```json
{
  "status": "authenticated",
  "accountId": "123456789"
}
```

### 2. Send a message

`target` can be a username or the numeric ID of a conversation.

```bash
curl -X POST http://127.0.0.1:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"target":"username","content":"Hello!"}'
```

### 3. Publish a Post immediately

The `media` path is local to the computer running the server.

```bash
curl -X POST http://127.0.0.1:3000/posts \
  -H "Content-Type: application/json" \
  -d '{"media":"C:/media/photo.jpg","caption":"My new post"}'
```

To publish a carousel, send an array:

```json
{
  "media": ["C:/media/1.jpg", "C:/media/2.jpg"],
  "caption": "Example carousel"
}
```

### 4. Schedule a Reel

`publishAt` must be a future ISO 8601 date with an explicit time zone. Instagram's native
scheduling requires a professional Creator or Business account.

```bash
curl -X POST http://127.0.0.1:3000/reels \
  -H "Content-Type: application/json" \
  -d '{"media":"C:/media/reel.mp4","caption":"New Reel","publishAt":"2026-08-18T17:00:00+01:00"}'
```

Without `publishAt`, the Post or Reel is published immediately.

### 5. Log out

```bash
curl -X POST http://127.0.0.1:3000/auth/logout
```

Logging out closes the browser and deletes the authenticated local profile. The next login will
ask for credentials again on the official Instagram page.

## Example usage — Node.js library

```js
const { Client, LocalAuth } = require('instagram-web.js');

async function main() {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: 'main-account' }),
    });

    client.on('login', () => console.log('Complete the login in the Instagram window'));
    client.on('ready', () => console.log('Client is ready'));
    client.on('message', async (message) => {
        console.log(message.from, message.body);
        if (message.body === '!ping') await message.reply('pong');
    });

    await client.initialize();
}

main().catch(console.error);
```

### Chats and messages

```js
const chats = await client.getChats({ limit: 20 });
const messages = await chats[0].fetchMessages({ limit: 20 });

await chats[0].sendMessage('Hello from the chat');
await client.sendMessage('username', 'Hello by username');
await client.sendMessage('NUMERIC_CONVERSATION_ID', 'Hello by conversation ID');
await messages[0].reply('Message reply');
```

### Publish content

```js
await client.publishPost('./media/photo.jpg', {
    caption: 'Post caption',
});

await client.publishPost('./media/reel.mp4', {
    caption: 'Reel published immediately',
});

await client.schedulePost('./media/reel.mp4', {
    caption: 'Scheduled Reel',
    publishAt: '2026-08-18T17:00:00+01:00',
});
```

Supported formats: AVIF, JPG/JPEG, PNG, HEIC, HEIF, MP4, and MOV. Captions must not exceed 2,200
characters. Scheduled dates must be in the future and no more than 75 days in advance.

## Supported features

| Feature | Status | Notes |
| --- | :---: | --- |
| Official login, 2FA, and security challenges | ✅ | Completed directly in the Instagram window |
| Persistent sessions (`LocalAuth`) | ✅ | One local profile per `clientId` |
| Login and logout over HTTP | ✅ | `/auth/login` and `/auth/logout` |
| List conversations | ✅ | `getChats()` |
| Read text messages | ✅ | Configurable polling |
| Send text messages | ✅ | By username or conversation ID |
| Reply to messages | ✅ | `Message.reply()` |
| Publish an image to the feed | ✅ | AVIF, JPG, PNG, HEIC, and HEIF |
| Publish a video/Reel | ✅ | MP4 or MOV |
| Publish a carousel | ⚠️ | Depends on the multiple-file selector exposed by Instagram Web |
| Schedule a Post natively | ✅ | Requires a professional account |
| Schedule a Reel natively | ✅ | Requires a professional account |
| Multiple accounts | ⚠️ | Use a separate `Client` and `clientId` for each account |
| Receive message attachments | ❌ | Not implemented yet |
| Send message attachments | ❌ | Not implemented yet |
| Stories | ❌ | Not implemented yet |
| Comments, likes, and followers | ❌ | Not implemented yet |
| Reactions and calls | ❌ | Not implemented yet |

Legend: ✅ supported · ⚠️ partial or interface-dependent support · ❌ not supported.

## HTTP API

| Method | Endpoint | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | — | General status, authentication state, and account ID |
| `GET` | `/auth/status` | — | `unauthenticated`, `authenticating`, or `authenticated` |
| `POST` | `/auth/login` | — | Starts or reuses an Instagram session |
| `POST` | `/auth/logout` | — | Logs out and deletes the local session |
| `POST` | `/messages` | `{ target, content }` | Sends a text message |
| `POST` | `/posts` | `{ media, caption, publishAt? }` | Publishes or schedules a Post |
| `POST` | `/reels` | `{ media, caption, publishAt? }` | Publishes or schedules an MP4/MOV Reel |

The API accepts JSON payloads up to 100 kB and returns errors as JSON:

```json
{
  "error": "Instagram is not authenticated"
}
```

### Server configuration

| Variable | Default | Description |
| --- | --- | --- |
| `INSTAGRAM_API_PORT` | `3000` | HTTP port between 1 and 65535 |
| `INSTAGRAM_API_KEY` | empty | Protects every endpoint with a Bearer token |

When an API key is configured, include the header with every request:

```bash
curl http://127.0.0.1:3000/health \
  -H "Authorization: Bearer YOUR_API_KEY"
```

For security, the server only listens on `127.0.0.1`.

## Events

| Event | Emitted when |
| --- | --- |
| `login` | Login must be completed in the browser window |
| `authenticated` | The session has been recognized |
| `auth_failure` | Login has failed or expired |
| `ready` | The inbox has loaded and the client is ready |
| `message` | A new message has been received |
| `message_create` | A message has been received or sent |
| `post_published` | Instagram has confirmed a publication |
| `post_scheduled` | Instagram has confirmed a scheduled publication |
| `post_error` | Publishing or scheduling has failed |
| `poll_error` | Periodic message polling has failed |
| `disconnected` | The browser has closed or the user has logged out |

## whatsapp-web.js equivalents

| whatsapp-web.js | instagram-web.js |
| --- | --- |
| `Client` | `Client` |
| `LocalAuth` | `LocalAuth` |
| `client.initialize()` | `client.initialize()` |
| `ready` event | `ready` event |
| `message` event | `message` event |
| `client.sendMessage()` | `client.sendMessage()` |
| `Chat.sendMessage()` | `Chat.sendMessage()` |
| `Message.reply()` | `Message.reply()` |

## How it works

1. Puppeteer starts a persistent Chromium profile.
2. The user authenticates on the official Instagram page.
3. The visible browser closes and restarts in headless mode.
4. Messages are polled through the session loaded in Instagram Web.
5. Messages and publications use Instagram's own Web interface.
6. Scheduled publications are stored by Instagram and do not depend on the Node.js process
   remaining online.

Do not share, archive, or publish `.instagram-web-auth/`. This directory contains the browser
session and grants access to the account while the session remains valid. It is already included
in `.gitignore`.

## Tests

```bash
npm test
```

## Contributing

Issues and pull requests are welcome. Before implementing a major change, open an issue to align
on the expected behavior, and include a small test for any new logic.

## Disclaimer

This project is not affiliated, associated, authorized, endorsed by, or officially connected to
Meta or Instagram. “Instagram” and related trademarks belong to their respective owners. There
is no guarantee that using this integration will not result in account restrictions, security
challenges, or suspension.

## License

[MIT](LICENSE)
