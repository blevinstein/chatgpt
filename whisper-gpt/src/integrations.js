import AWS from 'aws-sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import { backOff } from 'exponential-backoff';
import FormData from 'form-data';
import fs from 'fs';
import { Configuration, OpenAIApi } from 'openai';
import path from 'path';

import { COLOR, createInferId, getAudioDuration, hashValue, HOST, measureTime } from './common.js';

dotenv.config();

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const polly = new AWS.Polly();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODELS = {
    // NOTE: Stable diffusion 2.1 models. The faster model gives lower quality outputs.
    'stableDiffusion_21_fast': 'db21e45d3f7023abc2a46ee38a23973f6dce16bb082a930b0c49861f96d1e5bf',
    'stableDiffusion_21': 'f178fa7a1ae43a9a9af01b833b9d2ecf97b1bcb0acfd2dc5dd04895e042863f1',
    'latentDiffusion': '61935d993257c3926064d388c590d5b9f8efc288d1b2ec77568ed15c9115a346',
    'img2img': '15a3689ee13b0d2616e98820eca31d4c3abcd36672df6afce5cb6feb1d66087d',
    'blip-2': '4b32258c42e9efd4288bb9910bc532a69727f9acd26aa08e175713a0a857a608',
};
const REPLICATE_UNIT_PRICE = {
    // Costs per second
    'cpu': 0.0002,
    't4': 0.00055,
    'a100': 0.0023,
}
const REPLICATE_COST = {
    'stableDiffusion_21_fast': REPLICATE_UNIT_PRICE['a100'],
    'stableDiffusion_21': REPLICATE_UNIT_PRICE['a100'],
    'latentDiffusion': REPLICATE_UNIT_PRICE['t4'],
    'blip-2': REPLICATE_UNIT_PRICE['a100'],
};
const DEFAULT_REPLICATE_MODEL = 'stableDiffusion_21_fast';
const REPLICATE_POLL_TIME = 250;

const STABLE_DIFFUSION_PROMPT_ENHANCEMENT = {
    'realistic-vision-v13': (description) => `RAW photo, ${description}, (high detailed skin:1.2), 8k uhd, dslr, soft lighting, high quality, film grain, Fujifilm XT3`,
};

const STABLE_DIFFUSION_NEGATIVE_PROMPT = 'deformed iris, deformed pupils, text, close up, cropped, out of frame, worst quality, low quality, jpeg artifacts, ugly, duplicate, morbid, mutilated, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, blurry, dehydrated, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers';

const STABILITY_AI_KEY = process.env.STABILITY_AI_KEY;

const DEFAULT_IMG2IMG_MODEL = 'stableDiffusion_img2img';
const DEFAULT_IMG2IMG_MODEL_ID = '';
const DEFAULT_IMG2IMG_PROMPT_STRENGTH = 0.5;

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
const DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE = '768x768';

// Stable diffusion via their API costs $10/mo for 1k requests
const STABLE_DIFFUSION_PRICE = 0.01;

const DEFAULT_CHAT_MODEL = 'gpt-3.5-turbo';

const DEFAULT_DREAMBOOTH_MODEL_ID = 'midjourney';

const LOGS_BUCKET = 'whisper-gpt-logs';
const IMAGE_BUCKET = 'whisper-gpt-generated';
export const IMAGE_HOST = `https://${IMAGE_BUCKET}.s3.amazonaws.com`;

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

export function downloadFileFromS3(bucketName, key) {
    const params = {
        Bucket: bucketName,
        Key: key,
    };

    return new Promise((resolve, reject) => {
        s3.getObject(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

export async function listFilesInS3(bucketName) {
    const params = {
        Bucket: bucketName,
    };

    const results = [];
    let continuationToken;
    let listResponse;
    do {
        listResponse = await new Promise((resolve, reject) => {
          s3.listObjectsV2({ ...params, ContinuationToken: continuationToken }, (err, data) => {
              if (err) {
                  reject(err);
              } else {
                  resolve(data);
              }
          });
        });
        results.push(...listResponse.Contents);
        continuationToken = listResponse.NextContinuationToken;
    } while (listResponse.IsTruncated);

    return results;
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

export function getVoices() {
    return new Promise((resolve, reject) => {
        polly.describeVoices({}, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data.Voices);
            }
        });
    });
}

const DEFAULT_VOICE_ID = 'Matthew';
export function synthesizeSpeech(text, language, voice) {
    const params = {
        OutputFormat: "mp3",
        Text: language ? `<lang xml:lang="${language}">${text}</lang>` : text,
        TextType: 'ssml',
        VoiceId: voice || DEFAULT_VOICE_ID,
        Engine: 'neural',
    };

    return new Promise((resolve, reject) => {
        polly.synthesizeSpeech(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

export async function* generateChatCompletion({ messages, options = {}, user, inputImage }) {
    const model = options.chatModel || DEFAULT_CHAT_MODEL;
    const input = {
        model,
        messages: messages.map(({ role, content }) => ({ role, content: JSON.stringify(content) })),
        user: hashValue(user),
    };
    const [responseTime, response] = await measureTime(() => openai.createChatCompletion(input));
    const cost = OPENAI_CHAT_PRICE[model] * response.data.usage.total_tokens;
    const inferId = createInferId();
    yield inferId;

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);

    const parsedReply = JSON.parse(reply);
    yield parsedReply;

    const promises = parsedReply.map(element => {
        if (typeof element === 'string') {
            return Promise.resolve(element);
        } else if (typeof element === 'object') {
            switch (element.type) {
                case 'image':
                    return generateImageWithRetry({
                        prompt: element.prompt,
                        negativePrompt: element.negativePrompt,
                        options,
                        user
                    }).then((imageFile) => ({ ...element, imageFile }));
                case 'editImage':
                    const transformOptions = {
                        ...options,
                        imageModel: options.imageTransformModel || DEFAULT_IMG2IMG_MODEL,
                        imageModelId: options.imageTransformModelId,
                    };
                    return generateImageWithRetry({
                        prompt: element.prompt,
                        negativePrompt: element.negativePrompt,
                        options: transformOptions,
                        user,
                        inputImage: element.inputFile || inputImage,
                    }).then((imageFile) => ({ ...element, imageFile }));
                default:
                    throw new Error(`Element of unexpected type: ${JSON.stringify(element)}`);
            }
        }
    });
    const updatedReply = Array.from(await Promise.all(promises));
    await uploadFileToS3(
        LOGS_BUCKET,
        `chat-${inferId}.json`,
        JSON.stringify({
            type: 'createChatCompletion',
            input,
            response: response.data,
            cost,
            responseTime,
            user,
            inputImage,
            messages,
            reply: updatedReply,
            options,
            selfLink: `${HOST}?inferId=${inferId}`,
        }, null, 4),
        'application/json');
    yield updatedReply;
}

function updateImageInMessage(messageContents, imageData) {
    const elementIndex = messageContents.findIndex(e =>
        e.type === imageData.type && e.prompt === imageData.prompt);
    if (elementIndex >= 0) {
        messageContents[elementIndex] = imageData;
        return true;
    }
}

export async function updateImageInChatLog(inferId, imageData) {
    console.log(`Updating chatLog ${inferId} to add image: ${JSON.stringify(imageData)}`);
    const chatLog = JSON.parse(
        (await downloadFileFromS3(LOGS_BUCKET, `chat-${inferId}.json`)).Body.toString());

    // Update messages
    const messages = chatLog.messages;
    for (let message of messages) {
        if (updateImageInMessage(message.content, imageData)) {
            break;
        }
    }
    // Update reply
    const reply = chatLog.reply;
    updateImageInMessage(reply, imageData);

    console.log(`Updated data: ${JSON.stringify({messages, reply})}`);

    await uploadFileToS3(
        LOGS_BUCKET,
        `chat-${inferId}.json`,
        JSON.stringify({ ...chatLog, messages, reply }),
        'application/json');
}

function getGenerateImageFunction(options) {
    switch (options.imageModel) {
        case 'dallE':
            return generateImageWithDallE;
        case 'replicate':
            return generateImageWithReplicate;
        case 'stableDiffusion':
        case 'stableDiffusion_img2img':
            return generateImageWithStableDiffusion;
        case 'dreambooth':
        case 'dreambooth_img2img':
            return generateImageWithStableDiffusion;
        default:
            throw new Error(`Unexpected imageModel specified: ${options.imageModel}`);
    }
};

export async function generateImageWithRetry({ prompt, options, user, inputImage, negativePrompt }) {
    try {
        return await backOff(() => getGenerateImageFunction(options)({ prompt, options, user, inputImage, negativePrompt }), {
            numOfAttempts: 3,
            startingDelay: 2000,
            retry: (error, attemptNumber) => {
                console.error(`Image generation failed with ${options.imageModel}, attempt ${attemptNumber}`);
                return true;
            },
        });
    } catch (error) {
        console.error('Image generation failed:', error);
    }
};

export async function generateImageWithReplicate({ prompt, options, user, inputImage, negativePrompt }) {
    let input;
    const modelId = options.imageModelId || DEFAULT_REPLICATE_MODEL;
    switch (modelId) {
        case 'stableDiffusion_21':
        case 'stableDiffusion_21_fast':
            input = {
                prompt,
                negative_prompt: negativePrompt || STABLE_DIFFUSION_NEGATIVE_PROMPT,
                image_dimensions: options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE,
            };
            break;
        case 'latentDiffusion':
            input = {
                prompt,
                n_samples: 1,
            };
            break;
        case 'img2img':
            input = {
                image: inputImage,
                prompt,
                negative_prompt: negativePrompt || STABLE_DIFFUSION_NEGATIVE_PROMPT,
                prompt_strength: DEFAULT_IMG2IMG_PROMPT_STRENGTH,
                image_dimensions: options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE,
            };
            break;
        default:
            throw new Error(`Unexpected imageModelId: ${options.imageModelId}`);
    }
    const generateInput = {
        version: REPLICATE_MODELS[modelId],
        input,
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
            switch (modelId) {
                case 'stableDiffusion_21':
                case 'stableDiffusion_21_fast':
                    downloadUrl = statusResponse.data.output[0];
                    break;
                case 'latentDiffusion':
                    downloadUrl = statusResponse.data.output[0].image;
                    break;
            }
        }
    }

    const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const responseTime = performance.now() - startTime;
    const cost = statusResponse.data.metrics.predict_time * REPLICATE_COST[modelId];

    const inferId = createInferId();
    const imageFile = `${inferId}.png`;
    const imageUrl = `${IMAGE_HOST}/${imageFile}`;

    await uploadFileToS3(
        IMAGE_BUCKET,
        imageFile,
        Buffer.from(imageResponse.data),
        'image/png');
    await uploadFileToS3(
        LOGS_BUCKET,
        `image-${inferId}.json`,
        JSON.stringify({
            type: 'createImage',
            model: 'replicate',
            modelId,
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

    console.log(`Image generated by Replicate (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})[${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
    return imageUrl;
}

export async function generateImageWithDallE({ prompt, options, user }) {
    const imageSize = options.imageSize || OPENAI_IMAGE_SIZE;
    const generateInput = {
        prompt,
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
        const imageUrl = `${IMAGE_HOST}/${imageFile}`;
        const cost = OPENAI_IMAGE_PRICE[imageSize];

        await uploadFileToS3( IMAGE_BUCKET,
            imageFile,
            Buffer.from(imageResponse.data),
            'image/png');
        await uploadFileToS3(
            LOGS_BUCKET,
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
        throw new Error(`No image URL found in the response: ${JSON.stringify(generateResponse.data)}`);
    }
}

export async function generateImageWithStableDiffusion({ prompt, options, user, inputImage, negativePrompt }) {
    const [width, height] = (options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE)
        .split('x').map(Number);
    const inferId = createInferId();
    const isDreambooth = options.imageModel === 'dreambooth' || options.imageModel === 'dreambooth_img2img';

    if (isDreambooth && STABLE_DIFFUSION_PROMPT_ENHANCEMENT[options.imageModelId]) {
        prompt = STABLE_DIFFUSION_PROMPT_ENHANCEMENT[options.imageModelId](prompt);
    }
    const generateInput = {
        key: STABILITY_AI_KEY,
        model_id: isDreambooth ? options.imageModelId || DEFAULT_DREAMBOOTH_MODEL_ID : undefined,
        prompt,
        negative_prompt: negativePrompt || STABLE_DIFFUSION_NEGATIVE_PROMPT,
        init_image: inputImage,
        prompt_strength: inputImage ? DEFAULT_IMG2IMG_PROMPT_STRENGTH : undefined,
        samples: 1,
        width,
        height,
        num_inference_steps: 50,
        guidance_scale: 7.5,
        track_id: inferId,
    };

    let endpoint;
    switch (options.imageModel) {
        case 'dreambooth':
            endpoint = 'https://stablediffusionapi.com/api/v3/dreambooth';
            break;
        case 'dreambooth_img2img':
            endpoint = 'https://stablediffusionapi.com/api/v3/dreambooth/img2img';
            break;
        case 'stableDiffusion':
            endpoint = 'https://stablediffusionapi.com/api/v3/text2img';
            break;
        case 'stableDiffusion_img2img':
            endpoint = 'https://stablediffusionapi.com/api/v3/img2img';
            break;
        default:
            throw new Error(`Unexpected imageModel: ${options.imageModel}`);
    }

    const startTime = performance.now();
    const generateResponse = await axios.post(
        endpoint,
        generateInput,
        { responseType: 'json' },
    );

    if (generateResponse && generateResponse.data && generateResponse.data.output) {
        const downloadUrl = generateResponse.data.output[0];
        const imageResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        const responseTime = performance.now() - startTime;

        const imageFile = `${inferId}.png`;
        const imageUrl = `${IMAGE_HOST}/${imageFile}`;
        const cost = STABLE_DIFFUSION_PRICE;

        await uploadFileToS3(
            IMAGE_BUCKET,
            imageFile,
            Buffer.from(imageResponse.data),
            'image/png');
        await uploadFileToS3(
            LOGS_BUCKET,
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

        console.log(`Image generated by Stable Diffusion (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset})  [${inferId}] (${(responseTime / 1000).toFixed(2)}s)`);
        return imageUrl;
    } else {
        throw new Error(`No image URL found in the response: ${JSON.stringify(generateResponse.data)}`);
    }
}

// Uses Replicate and blip-2 for image interpretation.
// `question` is optional, default behavior is describing the image
export async function interpretImage(question, options, user, inputImage) {
    try {
        const input = {
            caption: !question,
            question,
            image: inputImage,
        };
        const generateInput = {
            version: REPLICATE_MODELS['blip-2'],
            input,
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
        let result;
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
                result = statusResponse.data.output;
            }
        }

        const responseTime = performance.now() - startTime;
        const cost = statusResponse.data.metrics.predict_time * REPLICATE_COST['blip-2'];

        const inferId = createInferId();

        await uploadFileToS3(
            LOGS_BUCKET,
            `interpret-${inferId}.json`,
            JSON.stringify({
                type: 'interpretImage',
                model: 'replicate',
                modelId: 'blip-2',
                input: generateInput,
                response: statusResponse.data,
                cost,
                predictTime: statusResponse.data.metrics.predict_time,
                responseTime,
                result,
                user,
                options,
            }, null, 4),
            'application/json');

        console.log(`Image interpreted by Replicate (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(3)}${COLOR.reset})[${inferId}] (${(responseTime/1000).toFixed(2)}s)`);
        return result;
    } catch (error) {
        console.error('Error interpreting image with Replicate:', error.message);
    }
}

