const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

const UPLOAD_FOLDER = 'uploads';
if (!fs.existsSync(UPLOAD_FOLDER)) {
    fs.mkdirSync(UPLOAD_FOLDER);
}

app.use(express.static('static'));

function getExtensionByMimeType(mimeType) {
    const extensions = {
        'audio/webm;codecs=opus': '.webm',
        'audio/ogg;codecs=opus': '.ogg',
        'audio/ogg;codecs=vorbis': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'audio/wave': '.wav',
        'audio/wav': '.wav',
        'audio/x-wav': '.wav',
    };

    return extensions[mimeType] || '';
}

app.post('/upload', upload.single('audio'), (req, res) => {
    if (req.file) {
        const mimeType = req.body.mimeType;
        const fileExtension = getExtensionByMimeType(mimeType);
        const oldPath = path.join(__dirname, req.file.path);
        const newPath = path.join(__dirname, req.file.path + fileExtension);

        fs.renameSync(oldPath, newPath);

        res.status(200).send('Upload successful');
    } else {
        res.status(400).send('Upload failed');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

