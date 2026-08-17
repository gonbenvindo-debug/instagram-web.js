'use strict';

class Message {
    constructor(client, data) {
        this.client = client;
        this._data = data.rawData || data;
        this.threadId = String(data.threadId);
        this.id = {
            id: String(data.id),
            _serialized: String(data.id),
            fromMe: Boolean(data.fromMe),
        };
        this.body = data.body || '';
        this.type = data.type || 'unknown';
        this.timestamp = Number(data.timestamp) || 0;
        this.from = data.from == null ? undefined : String(data.from);
        this.to = data.to == null ? undefined : String(data.to);
        this.author = this.from;
        this.fromMe = Boolean(data.fromMe);
    }

    get rawData() {
        return this._data;
    }

    getChat() {
        return this.client.getChatById(this.threadId);
    }

    reply(content) {
        return this.client.sendMessage(this.threadId, content);
    }
}

module.exports = Message;
