import bodyParser from 'body-parser';
import cookieSession from 'cookie-session';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import sanitize from 'sanitize-filename';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
    createId,
    detectLanguage,
    getExtensionByMimeType,
    HOST,
    remuxAudio,
    renderJsonReply
} from './common.js';
import {
    transcribeAudioFile,
} from './integration/whisper.js';
import {
    generateChatCompletion,
    streamChatCompletion,
    updateImageInChatLog
} from './integration/chat.js';
import {
    generateImageWithRetry,
    IMAGE_HOST,
    interpretImage,
} from './integration/image.js';
import {
    downloadFileFromS3,
    getAgent,
    getVoices,
    listAgents,
    listFilesInS3,
    putAgent,
    synthesizeSpeech,
} from './integration/aws.js';
import {
    fetchPage,
    scanPage,
} from './integration/browse.js';

const UPLOAD_FOLDER = 'uploads';
const PROMPT_FOLDER = 'prompt';
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

function getUser(req) {
    if (req.session && req.session.user && req.session.user.emails && req.session.user.emails[0]) {
        return req.session.user.emails[0].value;
    }
    return null;
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
    const argv = yargs(hideBin(process.argv))
        .option('auth', { type: 'boolean', default: true, description: 'Run with auth enabled' })
        .strictOptions()
        .argv;
    const app = express();
    const voices = await getVoices();

    // Setup CORS
    app.use(cors());

    // Setup JSON parsing
    app.use(bodyParser.json({limit: '50mb'}));

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

    // Login endpoints
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

    // Health check for load balancer
    app.get('/health-check', (req, res) => res.status(200).send('OK'));

    // ***** NOTE ***** Authenticated endpoints must go below this line, while unauthenticated endpoints
    // must go above this line!!!

    if (argv.auth) {
        app.use(ensureAuthenticated);
    } else {
        console.warn('Running with authentication disabled!');
    }

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

    app.post('/interpretImage', async (req, res) => {
        let { question, inputImage, options = {} } = req.body;

        const answer = await interpretImage(question, options, getUser(req), inputImage);
        res.json({ answer });
    });

    app.post('/renderMessage', async (req, res) => {
        let { message, inputImage, options = {} } = req.body;
        try {
            const html = renderJsonReply(message);
            res.json({ html });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.post('/generateImage', async (req, res) => {
        let { type, prompt, inputImage, negativePrompt, options = {} } = req.body;
        const transformOptions = {
            ...options,
            imageModel: options.imageTransformModel,
            imageModelId: options.imageTransformModelId,
        };
        try {
            const imageFile = type === 'editImage'
                ? await generateImageWithRetry({
                    prompt,
                    negativePrompt,
                    inputImage,
                    options: transformOptions,
                    user: getUser(req),
                })
                : await generateImageWithRetry({
                    prompt,
                    negativePrompt,
                    options,
                    user: getUser(req),
                });
            const html = renderJsonReply([{ type, prompt, inputImage, imageFile }]);
            if (!imageFile) throw new Error('No imageFile found');
            res.json({ imageFile, html });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    // Chat step 1: send a POST request here with your argument payload
    const chatArgs = new Map();
    app.post('/chatArgs', async (req, res) => {
        const streamId = createId();
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

        const { messages, inputImage, options = {} } = chatArgs.get(streamId);
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
            const chatCompletion = streamChatCompletion({ messages, options, user: getUser(req), inputImage });
            const { value: inferId } = await chatCompletion.next();
            writeEvent('setInferId', { inferId });

            const { value: reply } = await chatCompletion.next();
            // Detect language to assist speech synthesis on frontend
            const text = reply.filter(r => typeof r === 'string').join('\n\n');
            const language = await detectLanguage(text);
            // Immediately send the result to the frontend. At this point, the images are not yet
            // rendered.
            writeEvent('chatResponse', {
                language,
                raw: reply,
                html: renderJsonReply(reply, /* loading=*/ true),
            });

            const { value: updatedReply } = await chatCompletion.next();
            // Now, send the full result with images to the frontend.
            writeEvent('imagesLoaded', {
                language,
                raw: updatedReply,
                html: renderJsonReply(updatedReply),
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
                logLink: `${HOST}/chatLog/${inferId}`,
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
                editLink: `${HOST}/image?imageId=${inferId}`,
                imageLink: `${IMAGE_HOST}/${inferId}.png`,
            };
        });
        imageLogs.sort((a, b) => a.lastModified < b.lastModified ? 1 : -1);
        res.status(200).json(imageLogs);
    });

    app.get('/imageLog/:inferId', async (req, res) => {
        const { inferId } = req.params;
        try {
            const imageLog = JSON.parse(
                (await downloadFileFromS3('whisper-gpt-logs', `image-${inferId}.json`)).Body.toString());
            res.status(200).json(imageLog);
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.get('/chatLog/:inferId', async (req, res) => {
        const { inferId } = req.params;
        try {
            const chatLog = JSON.parse(
                (await downloadFileFromS3('whisper-gpt-logs', `chat-${inferId}.json`)).Body.toString());
            res.status(200).json(chatLog);
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.post('/chatLog/:inferId/updateImage', async (req, res) => {
        const { inferId } = req.params;
        const data = req.body;
        try {
            await updateImageInChatLog(inferId, data);
            res.status(200).json('Done');
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.get('/', function (req, res) {
        res.sendFile('views/index.html', { root: process.cwd() });
    });

    app.get('/createAgent', function (req, res) {
        res.sendFile('views/createAgent.html', { root: process.cwd() });
    });

    app.get('/chatAgent', function (req, res) {
        res.sendFile('views/chatAgent.html', { root: process.cwd() });
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
            const promptText = await fs.promises.readFile(filePath, { encoding: 'utf-8' });
            res.status(200).json({ text: promptText });
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

    app.get('/agent/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const agent = await getAgent(id);
            res.status(200).json(agent);
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });

    // Create new agent
    app.post('/agent', async (req, res) => {
        try {
            const { systemPrompt, options } = req.body;
            const id = createId();
            await putAgent({
                id,
                options,
                systemPrompt,
                messages: [],
                storage: {},
                logs: [],
            });
            res.status(200).json({ status: 'CREATED', id });
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });

    app.get('/agents', async (req, res) => {
        try {
            const agents = (await listAgents()).map(({ id: agentId }) => ({
                agentId,
                chatLink: `${HOST}/chatAgent?agentId=${agentId}`,
                logLink: `${HOST}/agent/${agentId}`,
            }));
            res.status(200).json({ agents });
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
        }
    });

    // TODO: app.post('/agent/:id') to update agent settings?

    app.post('/agent/:id/chat', async (req, res) => {
        try {
            const { id } = req.params;
            const { message } = req.body;
            const agent = await getAgent(id);
            if (message) {
                agent.messages.push({ role: 'user', content: message });
            }

            // TODO: Intelligently truncate messages when it gets too long
            // TODO: Add additional system prompt immediately before response with context?
            const { inferId: chatInferId, reply } = await generateChatCompletion({
                messages: [{ role: 'system', content: agent.systemPrompt }].concat(agent.messages),
                options: agent.options,
                user: getUser(req),
            });
            agent.logs.push({
                type: 'chat',
                inferId: chatInferId,
                logLink: `${HOST}/chatLog/${chatInferId}`,
            });
            agent.messages.push({ role: 'assistant', content: reply });

            // Generate additional system messages in response
            // TODO: Add safeguards around browsing capability
            for (let part of reply) {
                if (typeof part === 'object') {
                    switch (part.type) {
                        case 'browse':
                            try {
                                const { html, text } = await fetchPage(part.url);

                                // DEBUG
                                //console.log(html);

                                const { inferIds, summary } = await scanPage({
                                    url: part.url,
                                    html,
                                    task: part.task,
                                    options: agent.options,
                                    user: getUser(req),
                                });
                                inferIds.forEach(inferId => {
                                    agent.logs.push({
                                        type: 'browse',
                                        inferId,
                                        logLink: `${HOST}/chatLog/${inferId}`,
                                    });
                                });

                                agent.messages.push({
                                    role: 'system',
                                    content: [{
                                        type: 'browseResult',
                                        url: part.url,
                                        task: part.task,
                                        summary,
                                    }],
                                });
                            } catch (error) {
                                console.error(error);
                                agent.messages.push({
                                    role: 'system',
                                    content: [{
                                        type: 'browseResult',
                                        url: part.url,
                                        error: error.message,
                                    }],
                                });
                            }
                            break;
                    }
                }
            }

            await putAgent(agent);
            res.status(200).json({ messages: agent.messages });
        } catch (error) {
            console.error(error);
            res.status(500).send(error.message);
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
