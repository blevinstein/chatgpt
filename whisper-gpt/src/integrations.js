import AWS from 'aws-sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fs from 'fs';
import { Configuration, OpenAIApi } from 'openai';

import { COLOR, createInferId, getAudioDuration, hashValue, measureTime } from './common.js';

dotenv.config();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODELS = {
    // NOTE: Stable diffusion 2.1 models. The faster model gives lower quality outputs.
    'replicate_stableDiffusion_21_fast': 'db21e45d3f7023abc2a46ee38a23973f6dce16bb082a930b0c49861f96d1e5bf',
    'replicate_stableDiffusion_21': 'f178fa7a1ae43a9a9af01b833b9d2ecf97b1bcb0acfd2dc5dd04895e042863f1',
};
const REPLICATE_POLL_TIME = 250;

const STABILITY_AI_KEY = process.env.STABILITY_AI_KEY;

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

const OPENAI_IMAGE_SIZE = '1024x1024';

const WHISPER_PRICE = 0.006 / 60;

const REPLICATE_PRICE = {
    // Costs per second
    'cpu': 0.0002,
    't4': 0.00055,
    'a100': 0.0023,
}

const REPLICATE_STABLE_DIFFUSION_PRICE = REPLICATE_PRICE['a100'];
const DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE = '768x768';

// Stable diffusion via their API costs $10/mo for 1k requests
const STABLE_DIFFUSION_PRICE = 0.01;

export const IMAGE_REGEX = /IMAGE\s?\d{0,3}:?\s?\(([^()<>]*)\)/g;

const DEFAULT_CHAT_MODEL = 'gpt-3.5-turbo';

const DEFAULT_DREAMBOOTH_MODEL_ID = 'midjourney';

export function uploadFileToS3(bucketName, key, data, contentType) {
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

export async function* generateChatCompletion(messages, options = {}, user) {
    const model = options.chatModel || DEFAULT_CHAT_MODEL;
    const input = {
        model,
        messages,
        user: hashValue(user),
    };
    const [responseTime, response] = await measureTime(() => openai.createChatCompletion(input));
    const cost = OPENAI_CHAT_PRICE[model] * response.data.usage.total_tokens;
    const inferId = createInferId();

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);

    yield reply;

    const [ updatedReply, generatedImages ] = await generateInlineImages(reply, options, user);
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
            generatedImages,
            options,
        }, null, 4),
        'application/json');

    yield updatedReply;
}

// TODO: Add a config option or argument to switch between DALL-E and Stable Diffusion
export async function generateInlineImages(message, options = {}, user) {
    let generateImage;
    switch (options.imageModel) {
        case 'dallE':
            generateImage = generateImageWithDallE;
            break;
        case 'replicate_stableDiffusion_21':
        case 'replicate_stableDiffusion_21_fast':
            generateImage = generateImageWithReplicate;
            break;
        case 'stableDiffusion':
            generateImage = generateImageWithStableDiffusion;
            break;
        case 'dreambooth':
            generateImage = generateImageWithStableDiffusion;
            break;
        default:
            generateImage = generateImageWithDallE;
            console.error(`Unexpected imageModel specified: ${options.imageModel}`);
            break;
    }

    const imagePromises = [];
    for (let [pattern, description] of Array.from(message.matchAll(IMAGE_REGEX))) {
        imagePromises.push(generateImage(description, options, user)
            .then((imageFile) => [pattern, description, imageFile]));
    }
    let updatedMessage = message;
    const generatedImages = [];
    for (let [pattern, description, imageFile] of await Promise.all(imagePromises)) {
        updatedMessage = updatedMessage.replace(pattern, `![${description}](${imageFile})`);
        generatedImages.push({pattern, imageFile});
    }
    return [ updatedMessage, generatedImages ]
}

// Uses the Replicate API to run the Stable Diffusion model.
export async function generateImageWithReplicate(description, options, user) {
    try {
        const generateInput = {
            version: REPLICATE_MODELS[options.imageModel || 'stableDiffusion_21_fast'],
            input: {
                prompt: description,
                image_dimensions: options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE,
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
        const cost = statusResponse.data.metrics.predict_time * REPLICATE_STABLE_DIFFUSION_PRICE;

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
                model: 'replicate_stableDiffusion',
                input: generateInput,
                response: statusResponse.data,
                cost,
                predictTime: statusResponse.data.metrics.predict_time,
                responseTime,
                imageUrl,
                user,
                options,
            }, null, 4),
            'application/json');

        console.log(`Image generated by Replicate/Stable Diffusion (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})[${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
        return imageUrl;
    } catch (error) {
        console.error('Error generating image with Replicate/Stable Diffusion:', error.message);
    }
}

export async function generateImageWithDallE(description, options, user) {
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
                    options,
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

export async function generateImageWithStableDiffusion(description, options, user) {
    const [width, height] = (options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE)
        .split('x').map(Number);
    const inferId = createInferId();
    const isDreambooth = options.imageModel === 'dreambooth';

    try {
        const generateInput = {
            key: STABILITY_AI_KEY,
            model_id: isDreambooth ? options.imageModelId || DEFAULT_DREAMBOOTH_MODEL_ID : undefined,
            prompt: description,
            samples: 1,
            width,
            height,
            num_inference_steps: 20,
            guidance_scale: 7.5,
            track_id: inferId,
        };

        const startTime = performance.now();
        const generateResponse = await axios.post(
            isDreambooth
                ? 'https://stablediffusionapi.com/api/v3/dreambooth'
                : 'https://stablediffusionapi.com/api/v3/text2img',
            generateInput,
            { responseType: 'json' },
        );

        if (generateResponse && generateResponse.data && generateResponse.data.output) {
            const downloadUrl = generateResponse.data.output[0];
            const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
            const responseTime = performance.now() - startTime;

            const imageFile = `${inferId}.png`;
            const imageUrl = `https://whisper-gpt-generated.s3.amazonaws.com/${imageFile}`;
            const cost = STABLE_DIFFUSION_PRICE;

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
                    model: isDreambooth ? 'dreambooth' : 'stableDiffusion',
                    input: { ...generateInput, key: undefined },
                    response: generateResponse.data,
                    imageUrl,
                    responseTime,
                    user,
                    options,
                    cost,
                }, null, 4),
                'application/json');

            console.log(`Image generated by Stability Diffusion (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset})  [${inferId}] (${(responseTime / 1000).toFixed(2)}s)`);
            return imageUrl;
        } else {
            console.error('No image URL found in the response:', generateResponse.data);
        }
    } catch (error) {
        console.error('Error generating image with Stability Diffusion:', error.message);
    }
}


