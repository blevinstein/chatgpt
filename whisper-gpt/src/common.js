import crypto from 'crypto';

export function createInferId() {
    return crypto.randomBytes(6).toString('hex');
}

export async function measureTime(operation) {
    const startTime = performance.now();
    const returnValue = await operation();
    return [performance.now() - startTime, returnValue];
}

// Hash with a salt to anonymize data
const SALT = 'Whisper GPT salt';
export function hashValue(value) {
    return crypto.createHash('sha1').update(SALT).update(value).digest('hex');
}

export const COLOR = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
};
