import crypto from 'crypto';

import { detect } from 'langdetect';
import ffmpeg from 'fluent-ffmpeg';

export function createStreamId() {
    return crypto.randomBytes(16).toString('hex');
}

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

export function getExtensionByMimeType(mimeType) {
    const extensions = {
        'audio/webm': '.webm',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'audio/wave': '.wav',
        'audio/wav': '.wav',
        'audio/x-wav': '.wav',
    };

    return extensions[mimeType] || '';
}

export async function detectLanguage(text) {
  const languages = detect(text);
  console.log(`Inferred languages: ${JSON.stringify(languages)}`);
  return languages[0].lang;
}

export function remuxAudio(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .output(output)
            .audioCodec('copy')
            .noVideo()
            .on('end', () => {
                resolve();
            })
            .on('error', (err, stdout, stderr) => {
                console.error('Error during remuxing:', err);
                reject(err);
            })
            .run();
    });
}

export function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) {
                console.error('Error reading file:', error);
                return;
            }

            resolve(metadata.format.duration);
        });
    });
}
