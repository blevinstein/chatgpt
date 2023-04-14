
import dotenv from 'dotenv';
import { Configuration, OpenAIApi } from 'openai';

import { COLOR, createId, hashValue, HOST, measureTime } from '../common.js';
import { downloadFileFromS3, LOGS_BUCKET, uploadFileToS3 } from './aws.js';
import { generateImageWithRetry } from './image.js';

dotenv.config();

const OPENAI_KEY = process.env.OPENAI_KEY;
const configuration = new Configuration({
    apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(configuration);

const DEFAULT_CHAT_MODEL = 'gpt-3.5-turbo';

const DEFAULT_IMG2IMG_MODEL = 'stableDiffusion_img2img';

const OPENAI_CHAT_PRICE = {
    // Costs per token
    'gpt-3.5-turbo': 0.002e-3,
    'gpt-4': 0.03e-3,
};

// Simple wrapper around streamChatCompletion for cases when we don't care about streaming results
export async function generateChatCompletion({ messages, options = {}, user, inputImage }) {
    const chatCompletion = streamChatCompletion({
        messages,
        options,
        user,
        inputImage,
    });
    const { value: inferId } = await chatCompletion.next();
    const { value: _initialReply } = await chatCompletion.next();
    const { value: reply } = await chatCompletion.next();
    return { inferId, reply };
}

export async function* streamChatCompletion({ messages, options = {}, user, inputImage }) {
    const model = options.chatModel || DEFAULT_CHAT_MODEL;
    const input = {
        model,
        messages: messages.map(({ role, content }) => ({ role, content: JSON.stringify(content) })),
        user: hashValue(user),
    };
    const [responseTime, response] = await measureTime(() => openai.createChatCompletion(input));
    const cost = OPENAI_CHAT_PRICE[model] * response.data.usage.total_tokens;
    const inferId = createId();
    yield inferId;

    const rawReply = response.data.choices[0].message.content;
    console.log(`Assistant reply: ${rawReply} (${COLOR.red}cost: ${COLOR.green}\$${cost.toFixed(4)}${COLOR.reset}) [${inferId}] (${(responseTime/1000).toFixed(2)}s)`);

    // Be forgiving about what you accept from the chatbot, but strict about the output format.
    let reply;
    try {
        reply = JSON.parse(rawReply);
        if (!Array.isArray(reply) && typeof reply === 'object' && !!reply.type) {
            console.warn("JSON format violation: single object must be enclosed in list");
            reply = [ reply ];
        }
        if (!Array.isArray(reply) && typeof reply === 'string') {
            console.warn("JSON format violation: single string must be enclosed in list");
            reply = [ reply ];
        }
        if (!Array.isArray(reply)) {
            throw new Error(`Parsing failed, fallback to text treatment: ${rawReply}`);
        }
        reply.forEach(item => {
            if (typeof item === 'string') return;
            if (typeof item === 'object' && !!item.type) return;
            throw new Error(`Unexpected item: ${JSON.stringify(item)}`);
        });
    } catch (error) {
        reply = [ rawReply ];
    }

    // Remove imageFile values from certain commands, if they were erroneously provided.
    for (let element of reply) {
        if (element.type === 'image' || element.type === 'editImage') {
            element.imageFile = undefined;
        }
    }

    yield reply;

    const promises = reply.map(element => {
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
                        inputImage: element.inputFile || inputImage || getLastImage(messages),
                    }).then((imageFile) => ({ ...element, imageFile }));
                case 'browse':
                    // Do nothing
                    return Promise.resolve(element);
                default:
                    console.warn(`Element of unexpected type: ${JSON.stringify(element)}`);
                    return Promise.resolve(element);
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

    await uploadFileToS3(
        LOGS_BUCKET,
        `chat-${inferId}.json`,
        JSON.stringify({ ...chatLog, messages, reply }),
        'application/json');
}
