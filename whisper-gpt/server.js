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
//const STABLE_DIFFUSION_MODEL = 'db21e45d3f7023abc2a46ee38a23973f6dce16bb082a930b0c49861f96d1e5bf';
const STABLE_DIFFUSION_MODEL = 'f178fa7a1ae43a9a9af01b833b9d2ecf97b1bcb0acfd2dc5dd04895e042863f1';
const REPLICATE_POLL_TIME = 500;

const UPLOAD_FOLDER = 'uploads';
//const GENERATE_FOLDER = 'generated';
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

const CHAT_PRICING = {
  'gpt-3.5-turbo': 0.002e-3,
  'gpt-4': 0.03e-3,
};

const IMAGE_PRICING = {
  '256x256': 0.016,
  '512x512': 0.018,
  '1024x1024': 0.02,
};

const WHISPER_PRICE = 0.006 / 60;

const IMAGE_REGEX = /IMAGE\s?\(([^)]*)\)/g;
const IMAGE_SIZE = '1024x1024';

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
app.use(serveAuthenticatedStatic('static'));
//app.use(express.static(GENERATE_FOLDER));


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

async function detectLanguage(text) {
  const languages = detect(text);
  console.log(`Inferred languages: ${JSON.stringify(languages)}`);
  return languages[0].lang;
}

async function transcribeAudioFile(filePath) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');

    const audioDuration = await getAudioDuration(filePath);
    const cost = Math.ceil(audioDuration) * WHISPER_PRICE;

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/audio/transcriptions',
            formData,
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_KEY}`,
                    ...formData.getHeaders(),
                },
            }
        );
        const inferId = createInferId();
        await uploadFileToS3(
            'whisper-gpt-logs',
            `transcribe-${inferId}.json`,
            JSON.stringify({
                type: 'transcribe',
                input: filePath,
                response: response.data,
            }, null, 4),
            'application/json');

        console.log(`Transcribed ${audioDuration}s of audio: ${response.data.text} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}]`);
        return response.data.text;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        return null;
    }
}

async function generateImageWithStableDiffusion(description) {
    try {
        const generateInput = {
            version: STABLE_DIFFUSION_MODEL,
            input: {
                prompt: description,
            },
        };

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
        let imageUrl;
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
                imageUrl = statusResponse.data.output[0];
            }
        }

        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });

        // Save the image to disk
        const inferId = createInferId();
        const imageFile = `${inferId}.png`;

        /*
        fs.writeFileSync(
            path.join(__dirname, GENERATE_FOLDER, imageFile),
            Buffer.from(imageResponse.data), 'binary'
        );
        */
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
                imageFile,
            }, null, 4),
            'application/json');

        console.log(`Image generated by stable diffusion [${inferId}]`);
        return `https://whisper-gpt-generated.s3.amazonaws.com/${imageFile}`;
        // return imageFile;
    } catch (error) {
        console.error('Error generating image with Stable Diffusion:', error.message);
    }
}

async function generateImageWithDallE(description) {
    try {
        const generateInput = {
            prompt: description,
            n: 1,
            size: IMAGE_SIZE,
        };
        const generateResponse = await openai.createImage(generateInput);

        if (generateResponse
            && generateResponse.data
            && generateResponse.data.data
            && generateResponse.data.data[0]) {
            const imageUrl = generateResponse.data.data[0].url;
            const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });

            const inferId = createInferId();
            const imageFile = `${inferId}.png`;
            const cost = IMAGE_PRICING[IMAGE_SIZE];

            /*
            fs.writeFileSync(
                path.join(__dirname, GENERATE_FOLDER, imageFile),
                Buffer.from(imageResponse.data), 'binary');
            */
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
                    imageFile,
                }, null, 4),
                'application/json');

            console.log(`Image generated by DALL-E [${inferId}] (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})`);
            return `https://whisper-gpt-generated.s3.amazonaws.com/${imageFile}`;
            // return imageFile;
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

async function generateChatCompletion(messages) {
    const input = {
        model: CHAT_MODEL,
        messages,
    };
    const response = await openai.createChatCompletion(input);
    const cost = CHAT_PRICING[CHAT_MODEL] * response.data.usage.total_tokens;
    const inferId = createInferId();

    await uploadFileToS3(
        'whisper-gpt-logs',
        `chat-${inferId}.json`,
        JSON.stringify({
            type: 'createChatCompletion',
            input,
            response: response.data,
            cost,
        }, null, 4),
        'application/json');

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}]`);
    return reply;
}

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()
        || req.path === '/login'
        || req.path === '/auth/google/callback') {
        return next();
    }
    res.sendFile('views/forbidden.html', { root: __dirname });
}

function serveAuthenticatedStatic(staticPath) {
  return (req, res, next) => {
      ensureAuthenticated(req, res, () => {
          express.static(staticPath)(req, res, next);
      });
  }
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


app.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (req.file) {
        const mimeType = req.body.mimeType;
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
            const transcribedText = await transcribeAudioFile(newPath);
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

app.post('/chat', async (req, res) => {
    try {
        const { messages } = req.body;

        const reply = await generateChatCompletion(messages);

        // Detect language to assist speech synthesis on frontend
        const language = await detectLanguage(reply);

        let renderedReply = reply;

        for (let [pattern, description] of Array.from(reply.matchAll(IMAGE_REGEX))) {
          const imageFile = await generateImageWithStableDiffusion(description);
          //const imageFile = await generateImageWithDallE(description);
          renderedReply = renderedReply.replace(pattern, `![${description}](${imageFile})`);
        }

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

app.get('/login',
    passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { successRedirect: '/', failureRedirect: '/login' }));

app.get('/logout', function (req, res) {
    req.logout((error) => {
        if (error) return next(error);
        res.redirect('/');
    });
});

app.get('/prompts', async (req, res) => {
    const files = await fs.promises.readdir(PROMPT_FOLDER);
    const names = files.filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4));
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
        res.status(400).send('Prompt not found');
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

