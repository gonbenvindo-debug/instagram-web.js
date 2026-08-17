'use strict';

const { Client, LocalAuth } = require('./');

const client = new Client({
    authStrategy: new LocalAuth(),
});

client.on('login', () => {
    console.log('Conclua o login na janela do Instagram.');
});

client.on('authenticated', () => {
    console.log('Sessão autenticada.');
});

client.on('ready', () => {
    console.log('Cliente pronto para receber mensagens e publicar.');
});

client.on('message', async (message) => {
    console.log(`${message.from}: ${message.body}`);

    if (message.body === '!ping') {
        await message.reply('pong');
    }
});

client.on('poll_error', (error) => {
    console.error('Falha ao consultar mensagens:', error.message);
});

client.on('post_published', (post) => {
    console.log('Publicação concluída:', post.id);
});

client.on('post_error', (error) => {
    console.error('Falha ao publicar:', error.message);
});

client.initialize().catch(console.error);
