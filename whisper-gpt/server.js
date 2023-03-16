const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const FormData = require('form-data');
const langs = require('langs');
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
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}
const GENERATE_FOLDER = 'generated';
if (!fs.existsSync(GENERATE_FOLDER)) {
    fs.mkdirSync(GENERATE_FOLDER);
}

app.use(express.static('static'));
app.use(express.static(GENERATE_FOLDER));
app.use(express.json());

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

function convertIso6393ToIso6391(iso6393Code) {
    const langObj = langs.where('3', iso6393Code);
    if (langObj) {
        return langObj['1'];
    } else {
        console.log(`Unable to find ISO 639-1 code for the given ISO 639-3 code: ${iso6393Code}`);
        return null;
    }
}

async function detectLanguage(text) {
  console.log(`Inferring language for \"${text}\"`);
  const { franc } = await import('franc');

  // franc can return ISO 639-3 language codes. We want to convert them to ISO 639-1 codes.
  const languageCode = convertIso6393ToIso6391(franc(text));

  // If franc cannot detect the language or the text is too short, it returns 'und' (undetermined)
  if (languageCode === 'und') {
    console.log('Unable to determine the language of the text.');
    return null;
  }

  console.log(`Detected language code: ${languageCode}`);
  return languageCode;
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

        return response.data.text;
    } catch (error) {
        console.error('Error transcribing audio:', error.response.data || error);
        return null;
    }
}

async function generateImageWithDallE(description) {
  try {
    // Use the DALL-E API to generate an image from the description
    const result = await openai.createImage({
      prompt: description,
      n: 1,
      size: '256x256',
      //size: '1024x1024',
    });

    if (result && result.data && result.data.data && result.data.data[0]) {
      const imageUrl = result.data.data[0].url;
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });

      // Save the image to disk
      const filename = `${crypto.randomBytes(6).toString('hex')}.png`;
      const outputPath = path.join(__dirname, GENERATE_FOLDER, filename);
      fs.writeFileSync(outputPath, Buffer.from(imageResponse.data), 'binary');

      console.log(`Image saved to ${outputPath}`);
      return filename;
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

const IMAGE_REGEX = /IMAGE\(([^)]*)\)/g;

app.post('/chat', async (req, res) => {
    try {
        const { messages } = req.body;

        const response = await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages,
        });
        const reply = response.data.choices[0].message.content;
        console.log(`Assistant reply: ${reply}`);
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

