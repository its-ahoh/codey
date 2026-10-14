"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskBriefCache = void 0;
exports.taskBriefKey = taskBriefKey;
const crypto_1 = require("crypto");
function taskBriefKey(chat) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify({ title: chat.title, messages: chat.messages,
        pendingTeam: chat.pendingTeam, checklist: chat.checklist })).digest('hex');
}
/** Coalesce identical requests and never persist a result for obsolete input. */
class TaskBriefCache {
    constructor() {
        this.pending = new Map();
    }
    get(id, read, save, generate) {
        const chat = read();
        if (!chat)
            return Promise.resolve(null);
        const key = taskBriefKey(chat);
        if (chat.taskBrief?.inputKey === key)
            return Promise.resolve(chat.taskBrief);
        const active = this.pending.get(id);
        if (active?.key === key)
            return active.promise;
        const snapshot = structuredClone(chat);
        const entry = { key, promise: Promise.resolve(null) };
        entry.promise = Promise.resolve().then(() => generate(snapshot)).then(brief => {
            const current = read();
            if (this.pending.get(id) !== entry || !current || taskBriefKey(current) !== key)
                return null;
            const cached = { ...brief, inputKey: key };
            save(cached);
            return cached;
        }).finally(() => {
            if (this.pending.get(id) === entry)
                this.pending.delete(id);
        });
        this.pending.set(id, entry);
        return entry.promise;
    }
}
exports.TaskBriefCache = TaskBriefCache;
//# sourceMappingURL=task-brief-cache.js.map