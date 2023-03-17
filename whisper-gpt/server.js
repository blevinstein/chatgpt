const axios = require('axios');
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
const session = require('express-session');

dotenv.config();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const UPLOAD_FOLDER = 'uploads';
const GENERATE_FOLDER = 'generated';
const LOGS_FOLDER = 'logs';

const upload = multer({ dest: UPLOAD_FOLDER + '/' });

for (let folder of [UPLOAD_FOLDER, GENERATE_FOLDER, LOGS_FOLDER]) {
  if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder);
  }
}

const CHAT_PRICING = {
  'gpt-3.5-turbo': 0.002e-3,
};

const IMAGE_PRICING = {
  '256x256': 0.016,
  '512x512': 0.018,
  '1024x1024': 0.02,
};

const WHISPER_PRICE = 0.006 / 60;

const IMAGE_REGEX = /IMAGE\(([^)]*)\)/g;
const IMAGE_SIZE = '1024x1024';

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
//app.use(express.static('static'));
app.use(express.static(GENERATE_FOLDER));


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
        // Save logs to disk
        fs.writeFileSync(
            path.join(__dirname, LOGS_FOLDER, `transcribe-${createInferId()}.json`),
            JSON.stringify({
                type: 'transcribe',
                input: filePath,
                response: response.data,
            }, null, 4));

        console.log(`Transcribed ${audioDuration}s of audio: ${response.data.text} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset})`);
        return response.data.text;
    } catch (error) {
        console.error('Error transcribing audio:', error);
        return null;
    }
}

async function generateImageWithDallE(description) {
  try {
    // Use the DALL-E API to generate an image from the description
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

      // Save the image to disk
      const inferId = createInferId();
      const imageFile = `${inferId}.png`;
      const cost = IMAGE_PRICING[IMAGE_SIZE];
      fs.writeFileSync(
          path.join(__dirname, GENERATE_FOLDER, imageFile),
          Buffer.from(imageResponse.data), 'binary');
      // Save logs to disk
      fs.writeFileSync(
          path.join(__dirname, LOGS_FOLDER, `image-${inferId}.json`),
          JSON.stringify({
              type: 'createImage',
              input: generateInput,
              response: generateResponse.data,
              cost,
              imageFile,
          }, null, 4));

      console.log(`Image generated to ${imageFile} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})`);
      return imageFile;
    } else {
      console.log('No image URL found in the response');
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

    // Save logs to disk
    fs.writeFileSync(
        path.join(__dirname, LOGS_FOLDER, `chat-${createInferId()}.json`),
        JSON.stringify({
            type: 'createChatCompletion',
            input,
            response: response.data,
            cost,
        }, null, 4));

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset})`);
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



app.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (req.file) {
        const mimeType = req.body.mimeType;
        const fileExtension = getExtensionByMimeType(mimeType);

        // Rename and re-encode file to add missing webm duration metadata
        console.log(`Received audio of type ${mimeType} path ${req.file.path}, re-encoding...`);
        const oldPath = path.join(__dirname, req.file.path);
        const newPath = path.join(__dirname, UPLOAD_FOLDER, createInferId() + fileExtension);
        await remuxAudio(oldPath, newPath);
        fs.unlinkSync(oldPath);

        const transcribedText = await transcribeAudioFile(newPath);
        if (transcribedText) {
            res.status(200).send(transcribedText);
        } else {
            res.status(500).send('Transcription failed');
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

        // Use DALL-E to generate requested images
        const imageMatches = new Set(Array.from(reply.matchAll(IMAGE_REGEX)));
        let replyWithImages = reply;
        for (let [pattern, description] of imageMatches) {
          const imageFile = await generateImageWithDallE(description);
          replyWithImages = replyWithImages.replaceAll(pattern, `![${description}](${imageFile})`);
        }

        // Render markdown to HTML for display in the browser
        const html = markdown.render(replyWithImages);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

