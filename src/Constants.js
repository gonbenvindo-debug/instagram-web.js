'use strict';

exports.InstagramURL = 'https://www.instagram.com/';
exports.LoginURL = 'https://www.instagram.com/accounts/login/';
exports.InboxURL = 'https://www.instagram.com/direct/inbox/';

exports.Events = Object.freeze({
    LOGIN_REQUIRED: 'login',
    AUTHENTICATED: 'authenticated',
    AUTHENTICATION_FAILURE: 'auth_failure',
    READY: 'ready',
    MESSAGE_RECEIVED: 'message',
    MESSAGE_CREATE: 'message_create',
    POST_PUBLISHED: 'post_published',
    POST_SCHEDULED: 'post_scheduled',
    POST_EDITED: 'post_edited',
    POST_ERROR: 'post_error',
    POLL_ERROR: 'poll_error',
    DISCONNECTED: 'disconnected',
});
