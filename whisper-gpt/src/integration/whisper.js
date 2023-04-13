
import dotenv from 'dotenv';
import FormData from 'form-data';
import fs from 'fs';
import { Configuration, OpenAIApi } from 'openai';

import { COLOR, createInferId, getAudioDuration, measureTime } from '../common.js';
import { LOGS_BUCKET, uploadFileToS3 } from './aws.js';

dotenv.config();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const WHISPER_PRICE = 0.006 / 60;

export async function transcribeAudioFile(filePath, user) {
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
            LOGS_BUCKET,
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

