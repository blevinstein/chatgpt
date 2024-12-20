import crypto from 'crypto';

import { detect } from 'langdetect';
import ffmpeg from 'fluent-ffmpeg';
import MarkdownIt from 'markdown-it';

const markdown = MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
});

export function createId() {
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
    return crypto.createHash('sha1').update(SALT).update(value || '').digest('hex');
}

export const COLOR = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
};

export const HOST = 'https://synaptek.bio';

const LANGUAGE_TO_COMMON_COUNTRY = {
  'zh': 'zh-CN', // Chinese (Mandarin)
  'es': 'es-ES', // Spanish
  'en': 'en-US', // English
  'hi': 'hi-IN', // Hindi
  'ar': 'ar-SA', // Arabic
  'pt': 'pt-BR', // Portuguese
  'bn': 'bn-IN', // Bengali
  'ru': 'ru-RU', // Russian
  'ja': 'ja-JP', // Japanese
  'pa': 'pa-IN', // Punjabi
  'de': 'de-DE', // German
  'jv': 'jv-ID', // Javanese
  'ko': 'ko-KR', // Korean
  'te': 'te-IN', // Telugu
  'mr': 'mr-IN', // Marathi
  'fr': 'fr-FR', // French
  'it': 'it-IT', // Italian
  'nl': 'nl-NL', // Dutch
  'sv': 'sv-SE', // Swedish
  'da': 'da-DK', // Danish
  'fi': 'fi-FI', // Finnish
  'el': 'el-GR', // Greek
  'hu': 'hu-HU', // Hungarian
  'cs': 'cs-CZ', // Czech
  'pl': 'pl-PL', // Polish
  'ro': 'ro-RO', // Romanian
  'no': 'nb-NO', // Norwegian (Bokmål)
  'sk': 'sk-SK', // Slovak
  'hr': 'hr-HR', // Croatian
  'sr': 'sr-RS', // Serbian
  'sl': 'sl-SI', // Slovenian
  'lt': 'lt-LT', // Lithuanian
  'lv': 'lv-LV', // Latvian
  'et': 'et-EE', // Estonian
  'mt': 'mt-MT', // Maltese
};

const SPINNER_HTML = '<div class="spinner"></div>';

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
    if (languages && languages.length > 0) {
        return LANGUAGE_TO_COMMON_COUNTRY[languages[0].lang] || languages[0].lang;
    }
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

export function renderJsonReply(reply, loading = false) {
    if (!reply || typeof reply != 'object') {
        throw new Error(`Invalid reply to render: ${JSON.stringify(reply)}`);
    }

    let markdownReply = reply.map(element => {
        if (typeof element === 'string') {
            return element;
        }
        switch (element.type) {
            case 'image':
            case 'editImage':
                if (element.imageFile) {
                    return `![${element.prompt}](${element.imageFile})`;
                } else if (loading) {
                    return SPINNER_HTML;
                } else {
                    return `<span class="imageRetry">${JSON.stringify(element)}</span>`;
                }
                break;
            case 'browse':
                return `<span class="browseRequest">${JSON.stringify(element)}</span>`;
                break;
            case 'browseResult':
                return `<span class="browseResult">${JSON.stringify(element)}</span>`;
                break;
        }
    }).join('\n\n');
    return markdown.render(markdownReply);
}
