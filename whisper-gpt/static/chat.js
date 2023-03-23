// Internal representation of chat state
let selectedPrompts = [];
let systemPrompt = '';
let messages = [];
let messageImages = [];

// Cache of text prompts fetched from the server
const promptCache = {};

const OPTIONS_STORAGE_KEY = 'whispergpt-options';
const DEFAULT_OPTIONS = {
    chatModel: "gpt-3.5-turbo",
    voiceGender: "Female",
    imageModel: "stableDiffusion",
    imageSize: "512x512",
    imageModelId: "midjourney"
};

// NOTE: Keep in sync with src/integrations.js
const IMAGE_REGEX = /IMAGE\s?\d{0,3}:?\s?\[([^\[\]<>]*)\]/gi;

const MESSAGE_DURATION = 6000;
function showMessageBox(buttonSource, message) {
    const messageBox = buttonSource.parentElement.querySelector('.messageBox');
    messageBox.textContent = message;
    messageBox.classList.add('show');
    messageBox.addEventListener('mouseup', () => messageBox.classList.remove('show'));
    messageBox.addEventListener('touchend', () => messageBox.classList.remove('show'));
    setTimeout(() => messageBox.classList.remove('show'), MESSAGE_DURATION);
}

function addChatMessage(username, listItem, html, inferId) {
    // Clear existing contents
    listItem.innerHTML = '';

    const messageElement = cloneTemplate('message');
    messageElement.dataset.inferId = inferId;
    messageElement.querySelector('.username').textContent = `${username}: `;
    messageElement.querySelector('.contents').innerHTML = html;

    const copyButton = messageElement.querySelector('.copyButton');
    const copyMessageToClipboard = () => {
        navigator.clipboard.writeText(html);
        showMessageBox(copyButton, 'Copied message to clipboard!');
    };
    copyButton.addEventListener('mouseup', copyMessageToClipboard);
    copyButton.addEventListener('touchend', copyMessageToClipboard);

    const shareButton = messageElement.querySelector('.shareButton');
    if (inferId) {
        const copyLinkToClipboard = () => {
            navigator.clipboard.writeText(`https://synaptek.bio?inferId=${inferId}`);
            showMessageBox(shareButton, 'Copied link to clipboard!');
        }
        shareButton.addEventListener('mouseup', copyLinkToClipboard);
        shareButton.addEventListener('touchend', copyLinkToClipboard);
    } else {
        shareButton.classList.add('hidden');
    }

    // Add alt text to title in server-rendered images, so you can see text by hovering.
    messageElement.querySelectorAll('.contents img').forEach(img => img.title = img.alt);

    // Enable manual image generation retry
    messageElement.querySelectorAll('.contents .imageRetry').forEach(span => {
        span.addEventListener('mouseup', reloadImage);
        span.addEventListener('touchend', reloadImage);
    });

    listItem.appendChild(messageElement);
}

function createListItemWithSpinner() {
    const listItem = cloneTemplate('listItem');
    document.getElementById('messageList').appendChild(listItem);
    return listItem;
}

// Fetch options JSON stored in the HTML page
function getOptions() {
    try {
        return JSON.parse(document.getElementById('options').value.trim());
    } catch (error) {
        console.error('Failed to parse options:', error);
        return {};
    }
}

// Add a user-provided text message to the chat
async function sendTextMessage() {
    const message = textInput.value.trim();

    textInput.value = '';
    if (message.length > 0) {
        try {
            const listItem = createListItemWithSpinner();

            const response = await fetch('/renderMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, options: getOptions() }),
            });

            if (!response.ok) throw response.statusText;

            const { html } = await response.json();
            messages.push({ role: 'user', content: message });
            addChatMessage('user', listItem, html);
            document.getElementById('textInput').scrollIntoView();
        } catch (error) {
            console.error('Error rendering message:', error);
            listItem.remove();
        }
    } else {
        await requestChatResponse(getSystemPrompt(), messages);
    }
}

// Request re-rendering of a particular image in a chat response.
async function reloadImage(event) {
    const span = event.target;
    span.removeEventListener('mouseup', reloadImage);
    span.removeEventListener('touchend', reloadImage);

    const messageFragment = span.textContent;

    // Replace contents with a spinner
    span.textContent = '';
    span.appendChild(cloneTemplate('spinner'));

    try {
        const response = await fetch('/renderMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: messageFragment,
                options: getOptions(),
            }),
        });

        if (!response.ok) throw response.statusText;
        // NOTE: There should only be one image returned in `generatedImages` here, because there
        // was only one image in the fragment rendered.
        const { html, generatedImages } = await response.json();
        messageImages.push(generatedImages[0]);

        span.innerHTML = html;
        span.classList.remove('imageRetry');

        const inferId = span.closest('.message').dataset.inferId;
        if (inferId) {
            // Report image generation to server so it can fix chat logs
            await fetch(`/chatLog/${inferId}/updateImage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(generatedImages[0]),
            });
        }
    } catch (error) {
        console.log('Error retrying image:', error);
        // Restore span
        span.textContent = messageFragment;
        span.addEventListener('mouseup', reloadImage);
        span.addEventListener('touchend', reloadImage);
    }
}

// Get the full system prompt, including presets and custom input
function getSystemPrompt() {
    const customPrompt = document.getElementById('systemInput').value;
    return (systemPrompt + '\n\n'+ customPrompt).trim();
}

// Request a chat response from the chatbot API
async function requestChatResponse(systemPrompt, messages) {
    const chatListItem = createListItemWithSpinner();

    try {
        const chatArgsResponse = await fetch('/chatArgs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'system', content: systemPrompt}].concat(messages),
                images: messageImages,
                options: getOptions(),
            }),
        });

        if (!chatArgsResponse.ok) {
            console.error('Error setting chat args:', chatArgsResponse.statusText);
            chatListItem.remove();
            return;
        }
        const { streamId } = await chatArgsResponse.json();

        const chatStream = new EventSource(`/chat/${streamId}`);

        await new Promise(async (resolve, reject) => {
            let inferId;
            chatStream.onerror = (error) => {
                chatStream.close();
                reject(error);
            };
            // First response: an inference ID has been chosen, update the URL query param
            chatStream.addEventListener('setInferId', async (event) => {
                inferId = JSON.parse(event.data).inferId;
                const searchParams = new URLSearchParams(window.location.search);
                searchParams.set('inferId', inferId);
                history.pushState(null, '', window.location.pathname + '?' + searchParams.toString());
            });
            // Second response: chat text is available, but images are not yet loaded (if any)
            chatStream.addEventListener('chatResponse', async (event) => {
                const { text, language, html } = JSON.parse(event.data);
                console.log(`Chat response successful: ${text}`);
                addChatMessage('assistant', chatListItem, html, inferId);
                messages.push({ role: 'assistant', content: text });
                await announceMessage(text.replaceAll(IMAGE_REGEX, ''), language);
            });
            // Third response: images are loaded and the full response is available
            chatStream.addEventListener('imagesLoaded', async (event) => {
                const { text, language, html, generatedImages } = JSON.parse(event.data);
                console.log(`Images rendered successfully: ${text}`);
                messageImages.push(...generatedImages);
                addChatMessage('assistant', chatListItem, html, inferId);
                document.getElementById('sendTextButton').scrollIntoView();
                chatStream.close();
                resolve();
            });
            chatStream.addEventListener('exception', async (event) => {
                chatStream.close();
                reject(JSON.parse(event.data));
            });
        });
    } catch (error) {
        console.error('Error completing chat:', error);
        chatListItem.remove(); // Remove the listItem if the upload fails
        return;
    }
}

// Fetch the list of available prompt presets from the server
async function fetchPrompts(initialPrompts = [], customPrompt = '') {
    selectedPrompts = initialPrompts;
    document.getElementById('systemInput').value = customPrompt;

    try {
        const response = await fetch('/prompts');
        const prompts = await response.json();


        const promptButtonContainer = document.getElementById('promptButtonContainer');
        prompts.sort();
        prompts.forEach(prompt => {
            const button = cloneTemplate('promptButton');
            button.dataset.value = prompt;
            button.textContent = prompt;
            if (selectedPrompts.includes(prompt)) {
                button.classList.add('selected');
            }
            button.addEventListener('mouseup', togglePromptButton);
            button.addEventListener('touchend', togglePromptButton);
            promptButtonContainer.appendChild(button);
        });
        await Promise.all(selectedPrompts.map(p => getPromptData(p)));
        updateSystemPrompt();
    } catch (error) {
        console.error('Error fetching prompts:', error);
    }
}

// Updates the system prompt (internal text and visible HTML) based on `selectedPrompts`.
function updateSystemPrompt() {
    systemPrompt =
        selectedPrompts.map(p => promptCache[p].text).join('\n\n');
    document.getElementById('systemPrompt').innerHTML =
        selectedPrompts.map(p => promptCache[p].html).join('<br/><br/>');
}

// Fetch a prompt from the server
async function getPromptData(promptName) {
    try {
        const response = await fetch(`/prompt/${promptName}`);
        const responseData = await response.json();
        promptCache[promptName] = responseData;
        return responseData;
    } catch (error) {
        console.error('Error fetching prompt data:', error);
    }
}

// React to toggling of a preset prompt button
async function togglePromptButton(event) {
    event.preventDefault();
    const button = event.target;
    const isSelected = button.classList.toggle('selected');
    const promptName = button.dataset.value;

    if (isSelected) {
        await getPromptData(promptName);
        selectedPrompts.push(promptName);
    } else {
        selectedPrompts = selectedPrompts.filter(p => p !== promptName);
    }
    updateSystemPrompt();
}

// Get the build time from the server
async function fetchBuildTime() {
    // Build time is not available when running locally
    if (window.location.hostname == 'localhost') return;

    try {
        const response = await fetch('/build-time');

        if (!response.ok) throw response.statusText;
        const creationTime = await response.text();
        document.getElementById('buildTime').textContent = creationTime;
    } catch (error) {
        console.error('Error fetching build time:', error);
    }
}

// Get chat logs from the server, and update page state to match
async function fetchChatLogs(inferId) {
    const response = await fetch(`/chatLog/${inferId}`);

    if (!response.ok) {
        console.error('Error fetching chat log:', error);
        return;
    }

    // Clear preset prompts, and set the system prompt.
    selectedPrompts = [];
    updateSystemPrompt();
    Array.from(document.getElementsByClassName('selected')).forEach(e => e.classList.remove('selected'));
    const responseData = await response.json();
    document.getElementById('systemInput').value = responseData.input.messages[0].content;

    // Load messages, except the system message, including the response message.
    messages = responseData.input.messages.slice(1).concat(
        responseData.response.choices[0].message);
    messageImages = responseData.generatedImages;

    // Create list items synchronously, to ensure messages are rendered in the correct
    // order.
    const listItems = messages.map(() => createListItemWithSpinner());

    // Render all the messages server-side, using the already-generated images.
    await Promise.all(messages.map(async (message, messageIndex) => {
        const response = await fetch('/renderMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: message.content,
                options: getOptions(),
                generatedImages: responseData.generatedImages,
            }),
        });

        if (!response.ok) throw new Error('Failed to render message:', response.statusText);

        const { html } = await response.json();
        addChatMessage(
            message.role,
            listItems[messageIndex],
            html,
            // Add the inference link on the last message only. We don't have the
            // inference IDs for earlier chat responses in the thread.
            messageIndex === messages.length - 1 ? inferId : undefined);
    }));
}

function registerChatControls() {
    // Chat button:
    const sendTextButton = document.getElementById('sendTextButton');
    // Text input:
    sendTextButton.addEventListener('mouseup', sendTextMessage);
    sendTextButton.addEventListener('touchend', sendTextMessage);
    const textInput = document.getElementById('textInput');
    textInput.addEventListener('keypress', async (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            stopSpeaking();
            await sendTextMessage();
        }
    });
}

function registerSystemPromptControls() {
    const systemPromptCopyButton = document.getElementById('systemPromptCopyButton');
    const copySystemPromptToClipboard = () => {
        navigator.clipboard.writeText(getSystemPrompt());
        showMessageBox(systemPromptCopyButton, 'Copied prompt to clipboard!');
    }
    systemPromptCopyButton.addEventListener('mouseup', copySystemPromptToClipboard);
    systemPromptCopyButton.addEventListener('touchend', copySystemPromptToClipboard);
}