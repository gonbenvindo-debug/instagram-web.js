'use strict';

module.exports = {
    Client: require('./src/Client'),
    Chat: require('./src/structures/Chat'),
    Message: require('./src/structures/Message'),
    LocalAuth: require('./src/authStrategies/LocalAuth'),
    NoAuth: require('./src/authStrategies/NoAuth'),
    Events: require('./src/Constants').Events,
    version: require('./package.json').version,
};
