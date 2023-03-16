const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const FormData = require('form-data');
const { detect } = require('langdetect');
const markdown = require('markdown-it')();
const multer = require('multer');
const { Configuration, OpenAIApi } = require('openai');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const UPLOAD_FOLDER = 'uploads';
const GENERATE_FOLDER = 'generated';
const LOGS_FOLDER = 'logs';

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

const IMAGE_REGEX = /IMAGE\(([^)]*)\)/g;
const IMAGE_SIZE = '512x512';

const CHAT_MODEL = 'gpt-3.5-turbo';

const COLOR = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
};

app.use(express.static('static'));
app.use(express.static(GENERATE_FOLDER));
app.use(express.json());

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
        // Save metadata to disk
        fs.writeFileSync(
            path.join(__dirname, LOGS_FOLDER, `transcribe-${createInferId()}.json`),
            JSON.stringify({
                type: 'transcribe',
                response: response.data,
            }, null, 4));

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
      // Save metadata to disk
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

app.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (req.file) {
        const mimeType = req.body.mimeType;
        const fileExtension = getExtensionByMimeType(mimeType);

        console.log(`Received audio of type ${mimeType} path ${req.file.path}`);

        const oldPath = path.join(__dirname, req.file.path);
        const newPath = path.join(__dirname, req.file.path + fileExtension);
        fs.renameSync(oldPath, newPath);

        console.log('Transcribing audio...');
        const transcribedText = await transcribeAudioFile(newPath);
        if (transcribedText) {
            console.log(`Transcribed Text: ${transcribedText}`);
            res.status(200).send(transcribedText);
        } else {
            res.status(500).send('Transcription failed');
        }

        fs.unlinkSync(newPath); // Delete the audio file after transcription
    } else {
        res.status(400).send('Upload failed');
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { messages } = req.body;

        const input = {
            model: CHAT_MODEL,
            messages,
        };
        const response = await openai.createChatCompletion(input);
        const cost = CHAT_PRICING[CHAT_MODEL] * response.data.usage.total_tokens;
        // Save metadata to disk
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
        const language = await detectLanguage(reply);
        const matches = new Set(Array.from(reply.matchAll(IMAGE_REGEX)));
        let replyWithImages = reply;
        for (let [pattern, description] of matches) {
          console.log(`Generating image for ${pattern} / ${description}`);
          const imageFile = await generateImageWithDallE(description);
          replyWithImages = replyWithImages.replaceAll(pattern, `![${description}](${imageFile}) (${description})`);
        }
        console.log(`Assistant reply with image markup: ${replyWithImages}`);
        const html = markdown.render(replyWithImages);

        res.type('json');
        res.status(200).send(JSON.stringify({ text: reply, language, html }));
    } catch (error) {
        console.error('Error processing chat:', error);
        res.status(500).send('Error processing chat');
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

