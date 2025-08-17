// utils/sanitizer.js
function sanitizeInput(input) {
    return input.replace(/[^a-zA-Z0-9 .,!?@]/g, '').trim();
}

module.exports = {
    sanitizeInput
};