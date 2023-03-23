import AWS from 'aws-sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import { backOff } from 'exponential-backoff';
import FormData from 'form-data';
import fs from 'fs';
import { Configuration, OpenAIApi } from 'openai';
import path from 'path';

import { COLOR, createInferId, getAudioDuration, hashValue, HOST, measureTime, renderMessage } from './common.js';

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

// NOTE: Keep in sync with static/index.js
export const IMAGE_REGEX = /IMAGE\s?\d{0,3}:?\s?\[([^\[\]<>]*)\]/gi;
export const EDIT_REGEX = /EDIT\s?\d{0,3}:?\s?\[([^\[\]<>]*)\]/gi;

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
    let NextContinuationToken;
    let listResponse;
    do {
        listResponse = await new Promise((resolve, reject) => {
          s3.listObjectsV2({ ...params, NextContinuationToken }, (err, data) => {
              if (err) {
                  reject(err);
              } else {
                  resolve(data);
              }
          });
        });
        results.push(...listResponse.Contents);
        NextContinuationToken = listResponse.NextContinuationToken;
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

export async function* generateChatCompletion(messages, images, options = {}, user, inputImage) {
    const model = options.chatModel || DEFAULT_CHAT_MODEL;
    const input = {
        model,
        messages,
        user: hashValue(user),
    };
    const [responseTime, response] = await measureTime(() => openai.createChatCompletion(input));
    const cost = OPENAI_CHAT_PRICE[model] * response.data.usage.total_tokens;
    const inferId = createInferId();
    yield inferId;

    const reply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${reply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);

    yield reply;

    const [ updatedReply, generatedImages ] = await generateInlineImages(reply, options, user, inputImage);
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
            generatedImages: (images || []).concat(generatedImages),
            options,
            selfLink: `${HOST}?inferId=${inferId}`,
        }, null, 4),
        'application/json');

    yield { updatedReply, generatedImages };
}

export async function updateImageInChatLog(inferId, pattern, imageFile) {
    console.log(`Updating chatLog ${inferId} to add image: ${pattern} => ${imageFile}`);
    const chatLog = JSON.parse(
        (await downloadFileFromS3(LOGS_BUCKET, `chat-${inferId}.json`)).Body.toString());
    const generatedImages = chatLog.generatedImages;
    const patternIndex = generatedImages.findIndex(({ pattern: p }) => p === pattern);
    generatedImages[patternIndex].imageFile = imageFile;
    await uploadFileToS3(
        LOGS_BUCKET,
        `chat-${inferId}.json`,
        JSON.stringify({ ...chatLog, generatedImages }),
        'application/json');
}

// TODO: Add a config option or argument to switch between DALL-E and Stable Diffusion
export async function generateInlineImages(message, options = {}, user, inputImage) {
    let generateImage = (options) => {
        switch (options.imageModel) {
            case 'dallE':
                return generateImageWithDallE;
            case 'replicate':
                return generateImageWithReplicate;
            case 'stableDiffusion':
            case 'stableDiffusion_img2img':
                return generateImageWithStableDiffusion;
            case 'dreambooth':
                return generateImageWithStableDiffusion;
            default:
                console.error(`Unexpected imageModel specified: ${options.imageModel}`);
                return generateImageWithStableDiffusion;
        }
    };
    const generateImageWithRetry = (description, options, user, inputImage) =>
        backOff(() => generateImage(options)(description, options, user, inputImage), {
            numOfAttempts: 5,
            startingDelay: 1000,
            retry: (error, attemptNumber) => {
                console.error(`Image generation failed, attempt ${attemptNumber}:`, error);
            },
        });

    // Generate images in parallel using Promise.all
    const createImagePromises = Array.from(message.matchAll(IMAGE_REGEX))
        .map(([pattern, description]) => {
            return generateImageWithRetry(description, options, user)
                .then((imageFile) => [ pattern, imageFile ])
        });
    const editImagePromises = Array.from(message.matchAll(EDIT_REGEX))
        .map(([pattern, description]) => {
            const newOptions = {
                ...options,
                imageModel: options.imageTransformModel || DEFAULT_IMG2IMG_MODEL,
                imageModelId: options.imageTransformModelId,
            };
            return generateImageWithRetry(description, newOptions, user, inputImage)
                .then((imageFile) => [ pattern, imageFile ])
        });
    const imagePromises = createImagePromises.concat(editImagePromises);
    const generatedImages = Array.from(await Promise.all(imagePromises)).map(
        ([pattern, imageFile]) => ({ pattern, imageFile }));

    const failedImages = generatedImages.filter(({ pattern, imageFile }) => !imageFile);
    if (failedImages.length > 0) {
        console.error(`Failed to generate ${failedImages.length}/${generatedImages.length} images`);
    } else {
        console.log(`Generated ${generatedImages.length} images successfully`);
    }

    const updatedMessage = renderMessage(message, generatedImages);
    return [ updatedMessage, generatedImages ]
}

// Uses the Replicate API to run the Stable Diffusion model.
export async function generateImageWithReplicate(description, options, user, inputImage) {
    try {
        let input;
        const modelId = options.imageModelId || DEFAULT_REPLICATE_MODEL;
        switch (modelId) {
            case 'stableDiffusion_21':
            case 'stableDiffusion_21_fast':
                input = {
                    prompt: description,
                    negative_prompt: STABLE_DIFFUSION_NEGATIVE_PROMPT,
                    image_dimensions: options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE,
                };
                break;
            case 'latentDiffusion':
                input = {
                    prompt: description,
                    n_samples: 1,
                };
                break;
            case 'img2img':
                input = {
                    image: inputImage,
                    prompt: description,
                    negative_prompt: STABLE_DIFFUSION_NEGATIVE_PROMPT,
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

        // Save the image to disk
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
    } catch (error) {
        console.error('Error generating image with Replicate:', error.message);
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
            console.error('No image URL found in the response');
        }
    } catch (error) {
        console.error('Error generating image with DALL-E:', error.message);
    }
}

export async function generateImageWithStableDiffusion(description, options, user, inputImage) {
    const [width, height] = (options.imageSize || DEFAULT_STABLE_DIFFUSION_IMAGE_SIZE)
        .split('x').map(Number);
    const inferId = createInferId();
    const isDreambooth = options.imageModel === 'dreambooth';

    try {
        let prompt;
        if (isDreambooth && STABLE_DIFFUSION_PROMPT_ENHANCEMENT[options.imageModelId]) {
            prompt = STABLE_DIFFUSION_PROMPT_ENHANCEMENT[options.imageModelId](description);
        } else {
            prompt = description;
        }
        const generateInput = {
            key: STABILITY_AI_KEY,
            model_id: isDreambooth ? options.imageModelId || DEFAULT_DREAMBOOTH_MODEL_ID : undefined,
            prompt,
            negative_prompt: STABLE_DIFFUSION_NEGATIVE_PROMPT,
            init_image: inputImage,
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
            console.error('No image URL found in the response:', generateResponse.data);
        }
    } catch (error) {
        console.error('Error generating image with Stable Diffusion:', error.message);
    }
}


