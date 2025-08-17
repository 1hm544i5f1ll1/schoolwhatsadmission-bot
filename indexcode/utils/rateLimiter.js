// utils/rateLimiter.js
const NodeCache = require('node-cache');
const rateLimitCache = new NodeCache();

function isRateLimited(userId) {
    const userData = rateLimitCache.get(userId) || { count: 0 };
    if (userData.count >= 100) return true;
    userData.count += 1;
    rateLimitCache.set(userId, userData, 60);
    return false;
}

module.exports = {
    isRateLimited
};