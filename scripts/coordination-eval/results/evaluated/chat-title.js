"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openingChatTitle = openingChatTitle;
/** Reuse only titles that already meet the chat title's single-line limit. */
function openingChatTitle(classified, generate) {
    const title = classified?.trim();
    return title && title.length <= 40 && !/[\r\n]/.test(title)
        ? Promise.resolve(title) : generate();
}
//# sourceMappingURL=chat-title.js.map