const AWS = require('aws-sdk');
const axios = require('axios');
const child_process = require('child_process');
const crypto = require('crypto');
const dotenv = require('dotenv');
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const FormData = require('form-data');
const { detect } = require('langdetect');
const markdown = require('markdown-it')();
const multer = require('multer');
const { Configuration, OpenAIApi } = require('openai');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const sanitize = require('sanitize-filename');
const session = require('express-session');

dotenv.config();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
// NOTE: Stable diffusion 2.1 models. The faster model gives lower quality outputs.
const REPLICATE_MODELS = {
    'stableDiffusion_21_fast': 'db21e45d3f7023abc2a46ee38a23973f6dce16bb082a930b0c49861f96d1e5bf',
    'stableDiffusion_21': 'f178fa7a1ae43a9a9af01b833b9d2ecf97b1bcb0acfd2dc5dd04895e042863f1',
};
const REPLICATE_POLL_TIME = 250;

const UPLOAD_FOLDER = 'uploads';
const WORKSPACE_FOLDER = 'workspace';
const PROMPT_FOLDER = 'prompt';

const upload = multer({ dest: UPLOAD_FOLDER + '/' });

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

for (let folder of [UPLOAD_FOLDER, WORKSPACE_FOLDER]) {
  if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder);
  }
}

const OPENAI_CHAT_PRICE = {
    // Costs per token
    'gpt-3.5-turbo': 0.002e-3,
    'gpt-4': 0.03e-3,
};

const OPENAI_IMAGE_PRICE = {
    // Fixed costs per image size
    '256x256': 0.016,
    '512x512': 0.018,
    '1024x1024': 0.02,
};

const WHISPER_PRICE = 0.006 / 60;

const REPLICATE_PRICE = {
    // Costs per second
    'cpu': 0.0002,
    't4': 0.00055,
    'a100': 0.0023,
}

const STABLE_DIFFUSION_PRICE = REPLICATE_PRICE['a100'];
const STABLE_DIFFUSION_IMAGE_SIZE = '768x768';

const IMAGE_REGEX = /IMAGE\s?\(([^)]*)\)/g;

const OPENAI_IMAGE_SIZE = '1024x1024';

const LS_REGEX = /LS\(([^)]*)\)/g;
const CAT_REGEX = /CAT\(([^)]*)\)/g;
const WRITE_REGEX = /`*\s*WRITE\(([^)]*)\)\s*`*([^`]*)`+/g;

//const CHAT_MODEL = 'gpt-4';
const CHAT_MODEL = 'gpt-3.5-turbo';

const COLOR = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
};

function createInferId() {
    return crypto.randomBytes(6).toString('hex');
}

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

// Hash with a salt to anonymize data
const SALT = 'Whisper GPT salt';
function hashValue(value) {
    return crypto.createHash('sha1').update(SALT).update(value).digest('hex');
}

function getUser(req) {
    return req.user.emails[0].value;
}

async function detectLanguage(text) {
  const languages = detect(text);
  console.log(`Inferred languages: ${JSON.stringify(languages)}`);
  return languages[0].lang;
}

async function transcribeAudioFile(filePath, user) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');

    const audioDuration = await getAudioDuration(filePath);
    const cost = Math.ceil(audioDuration) * WHISPER_PRICE;

    try {
        const [responseTime, response] = await measureTime(() => axios.post(
            'https://api.openai.com/v1/audio/transcriptions',
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_KEY}`,
                    ...formData.getHeaders(),
                },
            }
        ));
        const inferId = createInferId();
        await uploadFileToS3(
            'whisper-gpt-logs',
            `transcribe-${inferId}.json`,
            JSON.stringify({
                type: 'transcribe',
                input: filePath,
                response: response.data,
                responseTime,
                user,
            }, null, 4),
            'application/json');

        console.log(`Transcribed ${audioDuration}s of audio: ${response.data.text} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
        return response.data.text;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        return null;
    }
}

async function generateImageWithStableDiffusion(description, options, user) {
    try {
        const generateInput = {
            version: REPLICATE_MODELS[options.imageModel || 'stableDiffusion_21_fast'],
            input: {
                prompt: description,
                image_dimensions: options.imageSize || STABLE_DIFFUSION_IMAGE_SIZE,
            },
        };

        const startTime = performance.now();
        const initiateResponse = await axios.post(
            'https://api.replicate.com/v1/predictions',
            generateInput,
            {
                headers: {
                    'Authorization': `Token ${REPLICATE_API_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const predictionId = initiateResponse.data.id;

        let predictionStatus = 'pending';
        let downloadUrl;
        let statusResponse;

        while (predictionStatus !== 'succeeded') {
            await new Promise(resolve => setTimeout(resolve, REPLICATE_POLL_TIME));

            statusResponse = await axios.get(
                `https://api.replicate.com/v1/predictions/${predictionId}`,
                {
                    headers: {
                        'Authorization': `Token ${REPLICATE_API_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            predictionStatus = statusResponse.data.status;

            if (predictionStatus === 'failed') {
                throw new Error('Prediction failed');
            }

            if (predictionStatus === 'succeeded') {
                downloadUrl = statusResponse.data.output[0];
            }
        }

        const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        const responseTime = performance.now() - startTime;
        const cost = statusResponse.data.metrics.predict_time * STABLE_DIFFUSION_PRICE;

        // Save the image to disk
        const inferId = createInferId();
        const imageFile = `${inferId}.png`;
        const imageUrl = `https://whisper-gpt-generated.s3.amazonaws.com/${imageFile}`;

        await uploadFileToS3(
            'whisper-gpt-generated',
            imageFile,
            Buffer.from(imageResponse.data),
            'image/png');
        await uploadFileToS3(
            'whisper-gpt-logs',
            `image-${inferId}.json`,
            JSON.stringify({
                type: 'createImage',
                model: 'stableDiffusion',
                input: generateInput,
                response: statusResponse.data,
                cost,
                predictTime: statusResponse.data.metrics.predict_time,
                responseTime,
                imageUrl,
                user,
            }, null, 4),
            'application/json');

        console.log(`Image generated by stable diffusion (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})[${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
        return imageUrl;
    } catch (error) {
        console.error('Error generating image with Stable Diffusion:', error.message);
    }
}

async function generateImageWithDallE(description, options, user) {
    try {
        const imageSize = options.imageSize || OPENAI_IMAGE_SIZE;
        const generateInput = {
            prompt: description,
            n: 1,
            size: imageSize,
            user: hashValue(user),
        };
        const startTime = performance.now();
        const generateResponse = await openai.createImage(generateInput);

        if (generateResponse
            && generateResponse.data
            && generateResponse.data.data
            && generateResponse.data.data[0]) {
            const downloadUrl = generateResponse.data.data[0].url;
            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const responseTime = performance.now() - startTime;

            const inferId = createInferId();
            const imageFile = `${inferId}.png`;
            const imageUrl = `https://whisper-gpt-generated.s3.amazonaws.com/${imageFile}`;
            const cost = OPENAI_IMAGE_PRICE[imageSize];

            await uploadFileToS3(
                'whisper-gpt-generated',
                imageFile,
                Buffer.from(imageResponse.data),
                'image/png');
            await uploadFileToS3(
                'whisper-gpt-logs',
                `image-${inferId}.json`,
                JSON.stringify({
                    type: 'createImage',
                    model: 'DALL-E',
                    input: generateInput,
                    response: generateResponse.data,
                    cost,
                    imageUrl,
                    responseTime,
                    user,
                }, null, 4),
                'application/json');

            console.log(`Image generated by DALL-E [${inferId}] (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset}) (${(responseTime/1000).toFixed(2)}s)`);
            return imageUrl;
        } else {
            console.error('No image URL found in the response');
        }
    } catch (error) {
        console.error('Error generating image with DALL-E:', error.message);
    }
}

function getAudioDuration(filePath) {
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

async function measureTime(operation) {
    const startTime = performance.now();
    const returnValue = await operation();
    return [performance.now() - startTime, returnValue];
}

async function generateChatCompletion(messages, options = {}, user) {
    const model = options.chatModel || CHAT_MODEL;
    const input = {
        model,
        messages,
        user: hashValue(user),
    };
    const [responseTime, response] = await measureTime(() => openai.createChatCompletion(input));
    const cost = OPENAI_CHAT_PRICE[model] * response.data.usage.total_tokens;
    const inferId = createInferId();

    await uploadFileToS3(
        'whisper-gpt-logs',
        `chat-${inferId}.json`,
        JSON.stringify({
            type: 'createChatCompletion',
            input,
            response: response.data,
            cost,
            responseTime,
            user,
        }, null, 4),
        'application/json');

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
    return reply;
}

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.sendFile('views/forbidden.html', { root: __dirname });
}

function uploadFileToS3(bucketName, key, data, contentType) {
    const params = {
        Bucket: bucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
    };

    return new Promise((resolve, reject) => {
        s3.upload(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

// TODO: Add a config option or argument to switch between DALL-E and Stable Diffusion
async function generateInlineImages(message, options = {}, user) {
    const imagePromises = [];
    const generateImage = options.imageModel == 'dallE'
        ? generateImageWithDallE
        : generateImageWithStableDiffusion;

    for (let [pattern, description] of Array.from(message.matchAll(IMAGE_REGEX))) {
        imagePromises.push(generateImage(description, options, user)
            .then((imageFile) => [pattern, description, imageFile]));
    }
    let updatedMessage = message;
    for (let [pattern, description, imageFile] of await Promise.all(imagePromises)) {
        updatedMessage = updatedMessage.replace(pattern, `![${description}](${imageFile})`);
    }
    return updatedMessage;
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
        const oldPath = path.join(__dirname, req.file.path);
        const newPath = path.join(__dirname, UPLOAD_FOLDER, createInferId() + fileExtension);
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
    const renderedMessage = await generateInlineImages(message, options, getUser(req));
    // Render markdown to HTML for display in the browser
    const html = markdown.render(renderedMessage);
    res.type('json');
    res.send(JSON.stringify({ html }));
});


app.post('/chat', async (req, res) => {
    try {
        const { messages, options = {} } = req.body;

        const reply = await generateChatCompletion(messages, options, getUser(req));

        // Detect language to assist speech synthesis on frontend
        const language = await detectLanguage(reply);

        const renderedReply = await generateInlineImages(reply, options, getUser(req));

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
                path.join(__dirname, WORKSPACE_FOLDER, sanitize(unsafePath)),
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
    res.sendFile('views/index.html', { root: __dirname });
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
    const filePath = path.join(__dirname, PROMPT_FOLDER, sanitize(req.params.name) + '.txt');
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
        const buildTime = await fs.promises.readFile(path.join(__dirname, 'build-time.txt'));
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

