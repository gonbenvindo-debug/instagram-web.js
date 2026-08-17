'use strict';

const fs = require('fs');
const path = require('path');
const BaseAuthStrategy = require('./BaseAuthStrategy');

class LocalAuth extends BaseAuthStrategy {
    constructor({ clientId, dataPath = './.instagram-web-auth' } = {}) {
        super();

        if (clientId && !/^[-_\w]+$/i.test(clientId)) {
            throw new Error('clientId accepts only letters, numbers, underscores and hyphens');
        }

        this.clientId = clientId;
        this.dataPath = path.resolve(dataPath);
        this.userDataDir = path.join(
            this.dataPath,
            this.clientId ? `session-${this.clientId}` : 'session',
        );
    }

    async beforeBrowserInitialized() {
        fs.mkdirSync(this.userDataDir, { recursive: true });

        if (
            this.client.options.puppeteer.userDataDir &&
            path.resolve(this.client.options.puppeteer.userDataDir) !== this.userDataDir
        ) {
            throw new Error('LocalAuth cannot be combined with puppeteer.userDataDir');
        }

        this.client.options.puppeteer.userDataDir = this.userDataDir;
    }

    async logout() {
        await fs.promises.rm(this.userDataDir, { recursive: true, force: true, maxRetries: 4 });
    }
}

module.exports = LocalAuth;
