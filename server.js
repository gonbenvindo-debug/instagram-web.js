'use strict';

const http = require('http');
const { Client, LocalAuth } = require('./');

function createApiServer(client, { apiKey } = {}) {
    let authentication;
    const authStatus = () => authentication
        ? 'authenticating'
        : client.pupPage ? 'authenticated' : 'unauthenticated';

    return http.createServer(async (request, response) => {
        const send = (status, data) => {
            const body = JSON.stringify(data);
            response.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            });
            response.end(body);
        };

        try {
            if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`) {
                return send(401, { error: 'Unauthorized' });
            }

            const route = `${request.method} ${new URL(request.url, 'http://localhost').pathname}`;
            if (route === 'GET /health') {
                const status = authStatus();
                return send(200, {
                    ready: status === 'authenticated',
                    authentication: status,
                    accountId: client.info?.id,
                });
            }
            if (route === 'GET /auth/status') {
                return send(200, { status: authStatus(), accountId: client.info?.id });
            }
            if (route === 'POST /auth/login') {
                if (!client.pupPage && !authentication) {
                    authentication = client.initialize().finally(() => { authentication = null; });
                }
                if (authentication) await authentication;
                return send(200, { status: 'authenticated', accountId: client.info?.id });
            }
            if (route === 'POST /auth/logout') {
                await client.logout();
                return send(200, { status: 'unauthenticated' });
            }
            if (!['POST /messages', 'POST /posts', 'POST /reels'].includes(route)) {
                return send(404, { error: 'Not found' });
            }
            if (authStatus() !== 'authenticated') {
                return send(409, { error: 'Instagram is not authenticated' });
            }
            if (!request.headers['content-type']?.startsWith('application/json')) {
                return send(415, { error: 'Content-Type must be application/json' });
            }

            let rawBody = '';
            for await (const chunk of request) {
                rawBody += chunk;
                if (rawBody.length > 100_000) {
                    const error = new Error('Request body is too large');
                    error.status = 413;
                    throw error;
                }
            }
            const body = JSON.parse(rawBody || '{}');

            if (route === 'POST /messages') {
                if (body.target == null) throw new TypeError('target is required');
                const message = await client.sendMessage(body.target, body.content);
                return send(200, {
                    id: message.id?._serialized,
                    threadId: message.threadId,
                    body: message.body,
                    timestamp: message.timestamp,
                });
            }

            const media = Array.isArray(body.media) ? body.media : [body.media];
            if (route === 'POST /reels' && (
                media.length !== 1 || !/\.(mp4|mov)$/i.test(String(media[0]))
            )) {
                throw new TypeError('A Reel requires one MP4 or MOV file');
            }
            const result = Object.hasOwn(body, 'publishAt')
                ? await client.schedulePost(body.media, {
                    caption: body.caption,
                    publishAt: body.publishAt,
                })
                : await client.publishPost(body.media, { caption: body.caption });
            return send(200, { type: route.endsWith('/reels') ? 'reel' : 'post', ...result });
        } catch (error) {
            send(error.status || (error instanceof TypeError || error instanceof SyntaxError ? 400 : 500), {
                error: error.message,
            });
        }
    });
}

async function main() {
    const port = Number(process.env.INSTAGRAM_API_PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('INSTAGRAM_API_PORT must be an integer between 1 and 65535');
    }

    const client = new Client({ authStrategy: new LocalAuth() });
    client.on('login', () => console.log('Conclua o login na janela do Instagram.'));
    client.on('post_error', (error) => console.error('Falha ao publicar:', error.message));
    client.on('poll_error', (error) => console.error('Falha ao consultar mensagens:', error.message));
    const server = createApiServer(client, { apiKey: process.env.INSTAGRAM_API_KEY });
    server.listen(port, '127.0.0.1', () => {
        console.log(`API pronta em http://127.0.0.1:${port}`);
        console.log('Use POST /auth/login para autenticar.');
    });

    const close = () => server.close(() => client.destroy());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

if (require.main === module) main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

module.exports = { createApiServer };
