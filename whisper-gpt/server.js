const axios = require('axios');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/' });


const UPLOAD_FOLDER = 'uploads';
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

app.use(express.static('static'));

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
                    'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
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


app.post('/upload', upload.single('audio'), async (req, res) => {
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
            console.log('Transcribed Text:', transcribedText);
            res.status(200).send(transcribedText);
        } else {
            res.status(500).send('Transcription failed');
        }

        fs.unlinkSync(newPath); // Delete the audio file after transcription
    } else {
        res.status(400).send('Upload failed');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

