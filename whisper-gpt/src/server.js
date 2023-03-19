import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { detect } from 'langdetect';
import MarkdownIt from 'markdown-it';
import multer from 'multer';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import path from 'path';
import sanitize from 'sanitize-filename';
import session from 'express-session';

import { COLOR, createInferId } from './common.js';
import { transcribeAudioFile, generateChatCompletion, generateInlineImages } from './integrations.js';

const markdown = MarkdownIt();

const UPLOAD_FOLDER = 'uploads';
const PROMPT_FOLDER = 'prompt';

const upload = multer({ dest: UPLOAD_FOLDER + '/' });

if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

/*
const LS_REGEX = /LS\(([^)]*)\)/g;
const CAT_REGEX = /CAT\(([^)]*)\)/g;
const WRITE_REGEX = /`*\s*WRITE\(([^)]*)\)\s*`*([^`]*)`+/g;
*/

function getExtensionByMimeType(mimeType) {
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

function getUser(req) {
    return req.user.emails[0].value;
}

async function detectLanguage(text) {
  const languages = detect(text);
  console.log(`Inferred languages: ${JSON.stringify(languages)}`);
  return languages[0].lang;
}

function remuxAudio(input, output) {
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

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.sendFile('views/forbidden.html', { root: process.cwd() });
}

const app = express();

// Setup JSON parsing
app.use(express.json());

// Initialize Passport and enable session support
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
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

app.get('/auth/google/callback',
    passport.authenticate('google', { successRedirect: '/', failureRedirect: '/login' }));

app.get('/health-check', (req, res) => res.status(200).send('OK'));

// ***** NOTE ***** Authenticated endpoints must go below this line, while unauthenticated endpoints
// must go above this line!!!
app.use(ensureAuthenticated);


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

// This is used for text
app.post('/renderMessage', async (req, res) => {
    const { message, options = {} } = req.body;
    const [ renderedMessage, generatedImages ] = await generateInlineImages(message, options, getUser(req));
    // Render markdown to HTML for display in the browser
    const html = markdown.render(renderedMessage);
    res.type('json');
    res.send(JSON.stringify({ html }));
});


app.post('/chat', async (req, res) => {
    try {
        const { messages, options = {} } = req.body;

        const [ reply, renderedReply ] = await generateChatCompletion(messages, options, getUser(req));

        // Detect language to assist speech synthesis on frontend
        const language = await detectLanguage(reply);

        // Apply code assistant hooks
        /*
        for (let [_, unsafePath] of Array.from(reply.matchAll(LS_REGEX))) {
            const command = `ls ${path.join(WORKSPACE_FOLDER, sanitize(unsafePath))}`;
            const output = child_process.execSync(command);
            renderedReply += `\n\n    $> ${command}\n\n    ${output}`;
        }
        for (let [_, unsafePath] of Array.from(reply.matchAll(CAT_REGEX))) {
            const command = `cat ${path.join(WORKSPACE_FOLDER, sanitize(unsafePath))}`;
            const output = child_process.execSync(command);
            renderedReply += `\n\n    $> ${command}\n\n    ${output}`;
        }
        for (let [_, unsafePath, contents] of Array.from(reply.matchAll(WRITE_REGEX))) {
            fs.writeFileSync(
                path.join(WORKSPACE_FOLDER, sanitize(unsafePath)),
                contents);
            renderedReply += `\n\n    ## wrote data to ${sanitize(unsafePath)}!`;
        }
        */

        // Render markdown to HTML for display in the browser
        const html = markdown.render(renderedReply);

        res.type('json');
        res.status(200).send(JSON.stringify({ text: reply, language, html }));
    } catch (error) {
        console.error('Error processing chat:', error);
        res.status(500).send('Error processing chat');
    }
});

app.get('/', function (req, res) {
    res.sendFile('views/index.html', { root: process.cwd() });
});

app.get('/logout', function (req, res) {
    req.logout((error) => {
        if (error) return next(error);
        res.redirect('/');
    });
});

app.get('/prompts', async (req, res) => {
    const files = await fs.promises.readdir(PROMPT_FOLDER);
    const names = files
        .filter(f => f.endsWith('.txt'))
        .map(f => f.slice(0, -4));
    res.type('json');
    res.status(200).send(JSON.stringify(names));
});

app.get('/prompt/:name', async (req, res) => {
    const filePath = path.join(PROMPT_FOLDER, sanitize(req.params.name) + '.txt');
    try {
        const promptData = await fs.promises.readFile(filePath, { encoding: 'utf-8' });
        const html = markdown.render(promptData);
        res.type('json');
        res.status(200).send(JSON.stringify({ text: promptData, html }));
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

process
    .on('unhandledRejection', (reason, p) => {
        console.error(reason, 'Unhandled Rejection at Promise', p);
    })
    .on('uncaughtException', error => {
        console.error(error, 'Uncaught Exception thrown');
        process.exit(1);
    });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

