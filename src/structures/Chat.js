'use strict';

const Message = require('./Message');

class Chat {
    constructor(client, data) {
        this.client = client;
        this._data = data.rawData || data;
        this.id = { _serialized: String(data.threadId) };
        this.name = data.name || '';
        this.users = data.users || [];
        this.unreadCount = Number(data.unreadCount) || 0;
        this.timestamp = Number(data.timestamp) || 0;
        this.lastMessage = data.lastMessage ? new Message(client, data.lastMessage) : undefined;
    }

    get rawData() {
        return this._data;
    }

    sendMessage(content) {
        return this.client.sendMessage(this.id._serialized, content);
    }

    fetchMessages(options) {
        return this.client.getMessages(this.id._serialized, options);
    }
}

module.exports = Chat;
