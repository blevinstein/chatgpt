// Internal representation of chat state
let allPrompts = [];
let selectedPrompts = [];
// Each message is { role: "system" or "user" or "assistant", content: "string" or { object } }
let messages = [];
// This is the image being edited in the image workspace.
let subjectImage;

// Cache of text prompts fetched from the server
const promptCache = {};

const MESSAGE_DURATION = 6000;
function showMessageBox(buttonSource, message) {
    const messageBox = buttonSource.parentElement.querySelector('.messageBox');
    messageBox.textContent = message;
    messageBox.classList.add('show');
    bindClick(messageBox, () => messageBox.classList.remove('show'));
    setTimeout(() => messageBox.classList.remove('show'), MESSAGE_DURATION);
}

function postProcessChat(chatElement) {
    chatElement.querySelectorAll('img').forEach(img => {
        // Add alt text to title in server-rendered images, so you can see text by hovering.
        img.title = img.alt;

        // If supported in this view, register drag-and-drop handler for mobile
        if (window.enableSyntheticDragAndDrop) {
            enableSyntheticDragAndDrop(img, img.src);
        }
    });

    // Enable manual image generation retry
    chatElement.querySelectorAll('.imageRetry')
        .forEach(span => bindClick(span, reloadImage));
}

function addChatMessage(username, listItem, html, inferId) {
    // Clear existing contents
    listItem.innerHTML = '';

    const messageElement = cloneTemplate('message');
    if (inferId) {
        messageElement.dataset.inferId = inferId;
    }
    messageElement.querySelector('.username').textContent = `${username}: `;
    messageElement.querySelector('.contents').innerHTML = html;

    const copyButton = messageElement.querySelector('.copyButton');
    bindClick(copyButton, () => {
        navigator.clipboard.writeText(html);
        showMessageBox(copyButton, 'Copied message to clipboard!');
    });

    const shareButton = messageElement.querySelector('.shareButton');
    if (inferId) {
        bindClick(shareButton, () => {
            navigator.clipboard.writeText(
                `${window.location.origin}${window.location.pathname}?inferId=${inferId}`);
            showMessageBox(shareButton, 'Copied link to clipboard!');
        });
    } else {
        shareButton.classList.add('hidden');
    }

    postProcessChat(messageElement.querySelector('.contents'));
    listItem.appendChild(messageElement);
}

function createListItemWithSpinner() {
    const listItem = cloneTemplate('listItem');
    document.getElementById('messageList').appendChild(listItem);
    return listItem;
}

// Add a user-provided text message to the chat
// TODO: Prevent request if another chat request is in-flight
async function sendTextMessage() {
    const message = textInput.value.trim();

    textInput.value = '';
    if (message.length > 0) {
        const listItem = createListItemWithSpinner();
        // TODO: Add support for user-generated image commands etc? Regex-based transformation?
        messages.push({ role: 'user', content: [ message ]});
        addChatMessage('user', listItem, message);
        document.getElementById('textInput').scrollIntoView();
    } else {
        await requestChatResponse();
    }
}

// Add a user-provided text message to the chat and request agent resposne
// TODO: Prevent request if another chat request is in-flight
async function sendAgentMessage() {
    const message = textInput.value.trim();

    textInput.value = '';
    const searchParams = new URLSearchParams(window.location.search);
    const agentId = searchParams.get('agentId');
    let listItem = createListItemWithSpinner();

    try {
        const response = await fetch(`/agent/${agentId}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message ? [ message ] : undefined }),
        });

        if (!response.ok) throw response.statusText;

        const { messages } = await response.json();
        for (let newMessage of messages.slice(messages.length - 2)) {
            const { html } = await renderMessage(newMessage.content);
            addChatMessage(newMessage.role, listItem || createListItemWithSpinner(), html);
            listItem = null;
        }
        document.getElementById('textInput').scrollIntoView();
    } catch (error) {
        console.error('Error getting agent chat response:', error);
    }
}

function getLastImage(messages) {
    const images = messages.flatMap(message =>
        message.content.filter(element => typeof element === 'object' && element.imageFile));
    if (images.length > 0) {
        return images[images.length - 1].imageFile;
    }
}

// Request re-rendering of a particular image in a chat response.
async function reloadImage(event) {
    const span = event.target;
    const command = JSON.parse(span.textContent);

    // Replace contents with a spinner
    span.textContent = '';
    span.appendChild(cloneTemplate('spinner'));

    try {
        const response = await fetch('/generateImage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // TODO: add negativePrompt
                type: command.type,
                prompt: command.prompt,
                inputImage: command.type === 'editImage'
                    ? (subjectImage || getLastImage(messages))
                    : undefined,
                options: getOptions(),
            }),
        });

        if (!response.ok) throw response.statusText;
        const { imageFile, html } = await response.json();
        if (!imageFile) {
            throw new Error('No imageFile in response');
        }

        // Retry was successful, we can remove the retry handler and styling.
        span.innerHTML = html;
        span.classList.remove('imageRetry');
        span.removeEventListener('click', reloadImage);
        postProcessChat(span);

        const inferId = span.closest('.message').dataset.inferId;
        if (inferId) {
            // Report image generation to server so it can fix chat logs
            await fetch(`/chatLog/${inferId}/updateImage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...command, imageFile }),
            });
        }
    } catch (error) {
        console.error('Error retrying image:', error);
        // Restore span
        span.textContent = messageFragment;
    }
}


// Get the full system prompt, including presets and custom input
async function getSystemPrompt() {
    const customPrompt = document.getElementById('systemInput').value;
    const promptParts = (await Promise.all(selectedPrompts
            .map(async p => (await getPromptData(p)).text)))
        .concat([customPrompt]);
    return promptParts.join('\n\n').trim();
}

function setInferId(inferId) {
    document.getElementById('whisperLink').href = `/?inferId=${inferId}`;
    document.getElementById('imageLink').href = `/image?inferId=${inferId}`;
}

// Request a chat response from the chatbot API
async function requestChatResponse() {
    const systemPrompt = await getSystemPrompt();
    const chatListItem = createListItemWithSpinner();

    try {
        const chatArgsResponse = await fetch('/chatArgs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'system', content: [ systemPrompt ]}].concat(messages),
                inputImage: subjectImage,
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
                setInferId(inferId);
                history.pushState(
                    null,
                    '',
                    window.location.pathname + '?' + searchParams.toString());
            });
            // Second response: chat text is available, but images are not yet loaded (if any)
            chatStream.addEventListener('chatResponse', async (event) => {
                const { raw, language, html } = JSON.parse(event.data);
                console.log(`Chat response successful: ${JSON.stringify(raw)}`);

                // Update UI and internal state
                addChatMessage('assistant', chatListItem, html, inferId);

                // Announce messagse
                const muted = document.getElementById('muteButton').classList.contains('muted');
                const textOnlyMessage = raw.filter(elem => typeof elem === 'string').join('\n');
                if (textOnlyMessage.trim().length > 0 && !muted) {
                    await announceMessage(textOnlyMessage, language);
                }
            });
            // Third response: images are loaded and the full response is available
            chatStream.addEventListener('imagesLoaded', async (event) => {
                const { raw, language, html } = JSON.parse(event.data);
                console.log(`Images rendered successfully: ${JSON.stringify(raw)}`);

                // Update UI
                addChatMessage('assistant', chatListItem, html, inferId);
                messages.push({ role: 'assistant', content: raw });
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
        if (!response.ok) throw response.statusText;

        allPrompts = await response.json();

        const promptButtonContainer = document.getElementById('promptButtonContainer');
        await Promise.all(allPrompts.map(p => getPromptData(p)));
        allPrompts.sort();
        allPrompts.forEach(async promptKey => {
            const button = cloneTemplate('promptButton');
            button.dataset.value = promptKey;
            button.textContent = promptKey;
            button.title = (await getPromptData(promptKey)).text.trim();
            if (selectedPrompts.includes(promptKey)) {
                button.classList.add('selected');
            }
            bindClick(button, togglePromptButton);
            promptButtonContainer.appendChild(button);
        });
    } catch (error) {
        console.error('Error fetching prompts:', error);
    }
}

// Fetch a prompt from the server
async function getPromptData(promptName) {
    if (promptCache[promptName]) {
        return promptCache[promptName];
    }
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
        selectedPrompts.push(promptName);
    } else {
        selectedPrompts = selectedPrompts.filter(p => p !== promptName);
    }
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

async function renderMessage(content) {
    const response = await fetch('/renderMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: content,
            options: getOptions(),
        }),
    });

    if (!response.ok) throw new Error('Failed to render message:', response.statusText);

    return response.json();
}

async function fetchAgent(agentId) {
    document.querySelector('#agentInfo #selfLink').href = `/chatAgent?agentId=${agentId}`;
    document.querySelector('#agentInfo #agentId').textContent = agentId;

    const response = await fetch(`/agent/${agentId}`);

    if (!response.ok) {
        console.error('Error fetching agent:', response.statusText);
        return;
    }
    const agentData = await response.json();

    // TODO: Add additional agent metadata to #agentInfo
    document.querySelector('#agentInfo #systemPrompt').textContent = agentData.systemPrompt;

    const messages = agentData.messages;

    // Create list items synchronously, to ensure messages are rendered in the correct
    // order.
    const listItems = messages.map(() => createListItemWithSpinner());

    // Render all the messages server-side, using the already-generated images.
    await Promise.all(messages.map(async (message, messageIndex) => {
        const { html } = await renderMessage(message.content);
        addChatMessage(
            message.role,
            listItems[messageIndex],
            html);
    }));

    // Move to the text input element, if that requires scrolling.
    document.getElementById('textInput').scrollIntoView();
}

// Get chat logs from the server, and update page state to match
async function fetchChatLogs(inferId) {
    const response = await fetch(`/chatLog/${inferId}`);

    if (!response.ok) {
        console.error('Error fetching chat log:', response.statusText);
        return;
    }
    const responseData = await response.json();

    setInferId(inferId);

    // Infer preset prompts from the full prompt.
    const fullPrompt = JSON.parse(responseData.input.messages[0].content)[0];
    let promptIndexes = Promise.all(
            allPrompts.map(async promptKey => {
                const promptText = (await getPromptData(promptKey)).text.trim();
                return [fullPrompt.indexOf(promptText), promptKey, promptText];
            }))
        .filter(([idx, key, value]) => idx >= 0);
    promptIndexes.sort((a, b) => a[0] - b[0]);
    selectedPrompts = promptIndexes.map(([idx, key, value]) => key);
    let customPrompt = fullPrompt;
    promptIndexes.forEach(([idx, key, value]) => {
        customPrompt = customPrompt.replace(value, '');
    });
    document.getElementById('systemInput').value = customPrompt.trim();

    Array.from(document.getElementsByClassName('selected')).forEach(e => {
        if (selectedPrompts.includes(e.dataset.value)) {
            e.classList.add('selected');
        } else {
            e.classList.remove('selected');
        }
    });

    // Load messages, except the system message, including the response message.
    messages = responseData.messages.slice(1).concat([{ role: 'assistant', content: responseData.reply }]);

    // Load the input image, if specified and supported by the editor environment
    if (responseData.inputImage && window.setSubjectImage) {
        setSubjectImage(responseData.inputImage);
    }

    // Create list items synchronously, to ensure messages are rendered in the correct
    // order.
    const listItems = messages.map(() => createListItemWithSpinner());

    // Render all the messages server-side, using the already-generated images.
    await Promise.all(messages.map(async (message, messageIndex) => {
        const { html } = await renderMessage(message.content);
        addChatMessage(
            message.role,
            listItems[messageIndex],
            html,
            // Add the inference link on the last message only. We don't have the
            // inference IDs for earlier chat responses in the thread.
            messageIndex === messages.length - 1 ? inferId : undefined);
    }));

    // Move to the text input element, if that requires scrolling.
    document.getElementById('textInput').scrollIntoView();
}

function registerChatControls(sendFunction = sendTextMessage) {
    // Chat button:
    bindClick(document.getElementById('sendTextButton'), sendFunction);
    // Text input:
    document.getElementById('textInput')
        .addEventListener('keypress', async (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                stopSpeaking();
                await sendFunction();
            }
        });
}

async function registerSystemPromptControls() {
    const systemPromptCopyButton = document.getElementById('systemPromptCopyButton');
    bindClick(systemPromptCopyButton, async () => {
        navigator.clipboard.writeText(await getSystemPrompt());
        showMessageBox(systemPromptCopyButton, 'Copied prompt to clipboard!');
    });
}
