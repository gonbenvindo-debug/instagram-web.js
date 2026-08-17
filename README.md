# instagram-web.js

Cliente não oficial do Instagram Web para mensagens, publicações e agendamentos, controlado por Puppeteer e com uma API inspirada no `whatsapp-web.js`.

Ele abre uma janela dedicada do Instagram para o utilizador fazer login manualmente. Após autenticar, a janela fecha e o Chromium reinicia invisível para continuar a receber mensagens. O perfil é guardado por `LocalAuth`, portanto as execuções seguintes reutilizam a sessão sem guardar a palavra-passe no código.

Não partilhe nem inclua `.instagram-web-auth/` em commits: essa pasta contém a sessão autenticada do navegador.

## Instalação

Requer Node.js 22.12 ou superior.

```bash
npm install
npm start
```

Com o servidor iniciado, chame `POST /auth/login` noutro terminal. Na primeira execução,
conclua o login, 2FA ou qualquer verificação diretamente na janela oficial do Instagram.

## Utilização

```js
const { Client, LocalAuth } = require('./');

async function main() {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: 'conta-principal' }),
    });

    client.on('login', () => console.log('Faça login na janela do Instagram'));
    client.on('ready', () => console.log('Pronto'));
    client.on('message', async (message) => {
        console.log(message.from, message.body);
        if (message.body === '!ping') await message.reply('pong');
    });

    await client.initialize();
}

main().catch(console.error);
```

Por padrão, `headlessAfterLogin` é `true`. Para manter a janela aberta:

```js
const client = new Client({
    authStrategy: new LocalAuth(),
    headlessAfterLogin: false,
});
```

Também é possível gerir conversas diretamente:

```js
const chats = await client.getChats();
const messages = await chats[0].fetchMessages({ limit: 20 });

await chats[0].sendMessage('Olá');
await client.sendMessage('nome_do_utilizador', 'Olá');
await client.sendMessage('ID_DA_THREAD', 'Olá novamente');
```

## Publicações

Espere pelo evento `ready` ou por `await client.initialize()` antes de publicar:

```js
await client.publishPost('./media/foto.jpg', {
    caption: 'Legenda da publicação',
});

await client.publishPost('./media/video.mp4', {
    caption: 'Publicação em vídeo',
});

await client.publishPost([
    './media/carrossel-1.jpg',
    './media/carrossel-2.jpg',
], {
    caption: 'Publicação em carrossel',
});
```

São aceites os formatos expostos atualmente pelo Instagram Web: AVIF, JPG/JPEG, PNG, HEIC, HEIF, MP4 e MOV. A função devolve um objeto local com `id`, `media`, `caption` e `publishedAt` depois de a interface confirmar a partilha.

## Agendamentos

```js
const scheduled = await client.schedulePost('./media/foto.jpg', {
    caption: 'Publicar mais tarde',
    publishAt: '2026-08-18T18:30:00+01:00',
});
```

`schedulePost()` utiliza o agendamento nativo do Instagram Web. É necessária uma conta profissional (Criador ou Empresa), a data deve estar no futuro e pode ter no máximo 75 dias de antecedência. Use uma data ISO com fuso horário explícito.

Depois de o Instagram confirmar o agendamento, o processo Node pode ser terminado. A publicação fica visível e pode ser gerida na app em `Perfil → Menu → Conteúdo agendado`.

## Eventos

- `login`: é necessário concluir o login na janela.
- `authenticated`: a sessão do Instagram foi reconhecida.
- `ready`: inbox carregada e polling iniciado.
- `message`: nova mensagem recebida.
- `message_create`: mensagem nova, recebida ou enviada.
- `post_published`: publicação concluída.
- `post_scheduled`: publicação aceite pelo agendamento nativo do Instagram.
- `post_error`: uma publicação imediata ou agendada falhou.
- `poll_error`: uma consulta periódica falhou.
- `disconnected`: sessão terminada ou janela fechada.

## API HTTP local

`npm start` inicia uma API em `http://127.0.0.1:3000`. Os ficheiros indicados em `media` têm de existir no computador onde o servidor está a correr.

| Método | Endpoint | Corpo JSON |
| --- | --- | --- |
| `GET` | `/health` | — |
| `GET` | `/auth/status` | — |
| `POST` | `/auth/login` | — |
| `POST` | `/auth/logout` | — |
| `POST` | `/messages` | `{ "target": "utilizador_ou_thread", "content": "Olá" }` |
| `POST` | `/posts` | `{ "media": "C:/media/foto.jpg", "caption": "Legenda" }` |
| `POST` | `/reels` | `{ "media": "C:/media/video.mp4", "caption": "Legenda" }` |

Para agendar nativamente um post ou Reel, adicione `publishAt`:

```json
{
  "media": "C:/media/video.mp4",
  "caption": "Reel agendado",
  "publishAt": "2026-08-18T16:00:00+01:00"
}
```

Para iniciar o login:

```bash
curl -X POST http://127.0.0.1:3000/auth/login
```

O pedido termina quando a autenticação estiver concluída. Se já existir uma sessão guardada,
ela é reutilizada sem abrir uma janela. Caso contrário, abre diretamente o login oficial;
após o sucesso, mostra a confirmação e fecha a janela automaticamente.

Para terminar a sessão e apagar o perfil local autenticado:

```bash
curl -X POST http://127.0.0.1:3000/auth/logout
```

Exemplo:

```bash
curl -X POST http://127.0.0.1:3000/messages \
  -H "Content-Type: application/json" \
  -d '{"target":"nome_do_utilizador","content":"Olá"}'
```

Use `INSTAGRAM_API_PORT` para mudar a porta. Se definir `INSTAGRAM_API_KEY`, todos os pedidos têm de enviar `Authorization: Bearer <chave>`. A API escuta apenas em `127.0.0.1`.

## Correspondência com whatsapp-web.js

- `Client extends EventEmitter` mantém a API orientada a eventos.
- `LocalAuth` atribui um `userDataDir` persistente ao Chromium.
- `initialize()` abre o site, autentica, prepara as mensagens e emite `ready`.
- `Message.reply()` delega em `Client.sendMessage()`.
- O browser envia mensagens pela interface; a leitura usa o endpoint interno carregado pela própria sessão do Instagram Web.

## Limites

Esta versão trata mensagens de texto e publicações de feed com imagem, vídeo ou carrossel. Ainda não inclui Stories, comentários, anexos de mensagens, reações, chamadas nem automação em massa.

É uma integração não oficial: alterações no Instagram Web podem exigir ajustes. Utilize apenas contas que controla, mantenha intervalos conservadores e não use para spam. A Meta pode limitar ou bloquear contas que apresentem comportamento automatizado.
