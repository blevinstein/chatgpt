import cookieSession from 'cookie-session';
import express from 'express';
import fs from 'fs';
import MarkdownIt from 'markdown-it';
import multer from 'multer';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import sanitize from 'sanitize-filename';

import { createStreamId, detectLanguage, getExtensionByMimeType, HOST, remuxAudio, renderMessage } from './common.js';
import {
    downloadFileFromS3,
    generateChatCompletion,
    generateInlineImages,
    getVoices,
    IMAGE_HOST,
    IMAGE_REGEX,
    listFilesInS3,
    synthesizeSpeech,
    transcribeAudioFile,
    updateImageInChatLog
} from './integrations.js';

const markdown = MarkdownIt({
    html: true,
    linkify: false,
    typographer: false,
});

const UPLOAD_FOLDER = 'uploads';
const PROMPT_FOLDER = 'prompt';
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

/*
const LS_REGEX = /LS\(([^)]*)\)/g;
const CAT_REGEX = /CAT\(([^)]*)\)/g;
const WRITE_REGEX = /`*\s*WRITE\(([^)]*)\)\s*`*([^`]*)`+/g;
*/

function getUser(req) {
    return req.session.user.emails[0].value;
}

function ensureAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.sendFile('views/forbidden.html', { root: process.cwd() });
}

const PORT = process.env.PORT || 3000;

process
    .on('unhandledRejection', (reason, p) => {
        console.error(reason, 'Unhandled Rejection at Promise', p);
    })
    .on('uncaughtException', error => {
        console.error(error, 'Uncaught Exception thrown');
        process.exit(1);
    });

async function main() {
    const app = express();
    const voices = await getVoices();

    // Setup JSON parsing
    app.use(express.json());

    // Initialize Passport and enable session support
    app.use(cookieSession({
        name: 'WhisperGPT-session',
        secret: process.env.SESSION_SECRET,
    }));
    app.use(passport.initialize());
    app.use(passport.session());

    // Configure Passport to use the Google OAuth2.0 strategy
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
      },
      (accessToken, refreshToken, profile, cb) => {
        // You can store user details in a database here
        return cb(null, profile);
      }
    ));

    // Serialize and deserialize user instances to and from the session
    passport.serializeUser((user, done) => {
      done(null, user);
    });

    passport.deserializeUser((user, done) => {
      done(null, user);
    });

    // Setup static serving
    app.use(express.static('static'));
    app.get('/login',
        passport.authenticate('google', { scope: ['profile', 'email'] }));

    app.get('/auth/google/callback', (req, res, next) => {
        passport.authenticate('google', (err, user, info) => {
            if (err) {
                return next(err);
            }
            if (!user) {
                return res.redirect('/login');
            }
            req.session.user = user;
            return res.redirect('/');
        })(req, res, next);
    });


    app.get('/health-check', (req, res) => res.status(200).send('OK'));

    // ***** NOTE ***** Authenticated endpoints must go below this line, while unauthenticated endpoints
    // must go above this line!!!
    app.use(ensureAuthenticated);

    const upload = multer({ dest: UPLOAD_FOLDER + '/' });
    app.post('/transcribe', upload.single('audio'), async (req, res) => {
        if (req.file) {
            const { mimeType } = req.body;
            const fileExtension = getExtensionByMimeType(mimeType);

            // Rename and re-encode file to add missing webm duration metadata
            console.log(`Received audio of type ${mimeType} path ${req.file.path}, re-encoding...`);
            const oldPath = req.file.path;
            const newPath = req.file.path + fileExtension;
            try {
                await remuxAudio(oldPath, newPath);
            } catch (error) {
                console.error('Remuxing audio failed', error);
                res.status(400).send('Bad audio provided');
                return;
            } finally {
                await fs.promises.unlink(oldPath);
            }

            try {
                const transcribedText = await transcribeAudioFile(newPath, getUser(req));
                res.status(200).send(transcribedText);
            } catch(error) {
                console.error('Transcription failed', error);
                res.status(500).send('Transcription failed');
                return;
            } finally {
                await fs.promises.unlink(newPath);
            }
        } else {
            res.status(400).send('Upload failed');
        }
    });

    app.post('/speak', async (req, res) => {
        let { text, language, voice, voiceGender } = req.body;

        if (!text) {
            res.status(400).send('Missing input text');
            return;
        }

        if (!voice) {
            // First try: do we have an exact language code match
            let candidateVoice = voices.find(v =>
                v.LanguageCode === language
                && (!voiceGender || voiceGender === v.Gender));
            if (candidateVoice) {
                voice = candidateVoice.Id;
            } else {
                // Second try: we do have a language match for another country
                candidateVoice = voices.find(v =>
                    v.LanguageCode.slice(0,2) === language.slice(0,2)
                    && (!voiceGender || voiceGender === v.Gender));
                if (candidateVoice) {
                    voice = candidateVoice.Id;
                }
                // else, fallback to the default voice
            }
        }

        try {
            const { AudioStream, ContentType } = await synthesizeSpeech(text, language, voice);
            res.type(ContentType);
            res.status(200).send(AudioStream);
        } catch (error) {
            console.log('Failed to speak:', error);
            res.status(500).send('Failed to speak');
        }
    });

    // This is used for text
    app.post('/renderMessage', async (req, res) => {
        let { message, generatedImages, options = {} } = req.body;

        let renderedMessage = message;
        if (generatedImages) {
            // This is a previously-generated chat message, so the generated images are already online.
            renderedMessage = renderMessage(message, generatedImages);
        } else {
            // Otherwise, generate new images using the appropriate API.
            [ renderedMessage, generatedImages ] = await generateInlineImages(message, options, getUser(req));
        }

        // Render markdown to HTML for display in the browser
        const html = markdown.render(renderedMessage);
        res.json({ html, generatedImages });
    });

    // Chat step 1: send a POST request here with your argument payload
    const chatArgs = new Map();
    app.post('/chatArgs', async (req, res) => {
        const streamId = createStreamId();
        chatArgs.set(streamId, req.body);
        console.log(`Chat request prepared [${streamId}]`);
        res.status(200).json({ streamId });
    });

    // Chat step 2: open an event stream here with your streamId from Step 1
    app.get('/chat/:streamId', async (req, res) => {
        const { streamId } = req.params;
        if (!chatArgs.has(streamId)) {
            res.status(400).send('Request does not exist or already executed');
            return;
        }

        const { messages, images, options = {} } = chatArgs.get(streamId);
        chatArgs.delete(streamId);
        console.log(`Chat stream started [${streamId}]`);

        // Set headers to prepare for streaming server-sent events
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const writeEvent = (eventType, data) => {
          res.write(`event: ${eventType}\ndata:${JSON.stringify(data)}\n\n`);
        };

        try {
            const chatCompletion = generateChatCompletion(messages, images, options, getUser(req));
            const { value: inferId } = await chatCompletion.next();
            writeEvent('setInferId', { inferId });

            const { value: reply } = await chatCompletion.next();
            // Detect language to assist speech synthesis on frontend
            const language = await detectLanguage(reply);
            // Immediately send the result to the frontend. At this point, the images are not yet
            // rendered.
            writeEvent('chatResponse', {
                language,
                text: reply,
                html: markdown.render(reply).replaceAll(IMAGE_REGEX, '\n\n<div class="spinner"></div>\n\n'),
            });

            // Apply code assistant hooks
            /*
            for (let [_, unsafePath] of Array.from(reply.matchAll(LS_REGEX))) {
                const command = `ls ${path.join(WORKSPACE_FOLDER, sanitize(unsafePath))}`;
                const output = child_process.execSync(command);
                updatedReply += `\n\n    $> ${command}\n\n    ${output}`;
            }
            for (let [_, unsafePath] of Array.from(reply.matchAll(CAT_REGEX))) {
                const command = `cat ${path.join(WORKSPACE_FOLDER, sanitize(unsafePath))}`;
                const output = child_process.execSync(command);
                updatedReply += `\n\n    $> ${command}\n\n    ${output}`;
            }
            for (let [_, unsafePath, contents] of Array.from(reply.matchAll(WRITE_REGEX))) {
                fs.writeFileSync(
                    path.join(WORKSPACE_FOLDER, sanitize(unsafePath)),
                    contents);
                updatedReply += `\n\n    ## wrote data to ${sanitize(unsafePath)}!`;
            }
            */

            const { updatedReply, generatedImages } = (await chatCompletion.next()).value;
            // Now, send the full result with images to the frontend.
            writeEvent('imagesLoaded', {
                language,
                text: updatedReply,
                html: markdown.render(updatedReply),
                generatedImages,
            });
        } catch (error) {
            console.error('Error completing chat:', error);
            writeEvent('exception', error);
        }
    });

    app.get('/chatLogs', async (req, res) => {
        const logs = await listFilesInS3('whisper-gpt-logs');
        const inferIdRegex = /chat-([0-9a-f]*)\.json/;
        const chatLogs = logs.flatMap(log => {
            const match = log.Key.match(inferIdRegex);
            if (!match) return [];
            const [_, inferId] = match;
            return {
                inferId,
                lastModified: log.LastModified,
                selfLink: `${HOST}?inferId=${inferId}`,
            };
        });
        chatLogs.sort((a, b) => a.lastModified < b.lastModified ? 1 : -1);
        res.status(200).json(chatLogs);
    });

    app.get('/imageLogs', async (req, res) => {
        const logs = await listFilesInS3('whisper-gpt-logs');
        const inferIdRegex = /image-([0-9a-f]*)\.json/;
        const imageLogs = logs.flatMap(log => {
            const match = log.Key.match(inferIdRegex);
            if (!match) return [];
            const [_, inferId] = match;
            return {
                inferId,
                lastModified: log.LastModified,
                logLink: `${HOST}/imageLog/${inferId}`,
                imageLink: `${IMAGE_HOST}/${inferId}.png`,
            };
        });
        imageLogs.sort((a, b) => a.lastModified < b.lastModified ? 1 : -1);
        res.status(200).json(imageLogs);
    });

    app.get('/imageLog/:inferId', async (req, res) => {
        const { inferId } = req.params;
        const imageLog = JSON.parse(
            (await downloadFileFromS3('whisper-gpt-logs', `image-${inferId}.json`)).Body.toString());
        res.status(200).json(imageLog);
    });

    app.get('/chatLog/:inferId', async (req, res) => {
        const { inferId } = req.params;
        const chatLog = JSON.parse(
            (await downloadFileFromS3('whisper-gpt-logs', `chat-${inferId}.json`)).Body.toString());
        res.status(200).json(chatLog);
    });

    app.post('/chatLog/:inferId/updateImage', async (req, res) => {
        const { inferId } = req.params;
        const { pattern, imageFile } = req.body;
        await updateImageInChatLog(inferId, pattern, imageFile);
        res.status(200).json('Done');
    });

    app.get('/', function (req, res) {
        res.sendFile('views/index.html', { root: process.cwd() });
    });

    app.get('/gallery', function (req, res) {
        res.sendFile('views/gallery.html', { root: process.cwd() });
    });

    app.get('/image', function (req, res) {
        res.sendFile('views/image.html', { root: process.cwd() });
    });

    app.get('/logout', function (req, res) {
        req.session.user = null;
        res.redirect('/');
    });

    app.get('/prompts', async (req, res) => {
        const files = await fs.promises.readdir(PROMPT_FOLDER);
        const names = files
            .filter(f => f.endsWith('.txt'))
            .map(f => f.slice(0, -4));
        res.status(200).json(names);
    });

    app.get('/prompt/:name', async (req, res) => {
        const filePath = path.join(PROMPT_FOLDER, sanitize(req.params.name) + '.txt');
        try {
            const promptData = await fs.promises.readFile(filePath, { encoding: 'utf-8' });
            const html = markdown.render(promptData);
            res.status(200).json({ text: promptData, html });
        } catch (error) {
            console.error(`Prompt not found: ${req.params.name}`, error);
            res.status(400).send(`Prompt not found`);
        }
    });

    app.get('/build-time', async (req, res) => {
        try {
            const buildTime = await fs.promises.readFile('build-time.txt');
            res.status(200).send(buildTime);
        } catch (error) {
            res.status(500).send('Build time not found!');
        }
    });

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

main()
    .then(() => {})
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
