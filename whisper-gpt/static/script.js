let mediaStream;
let mediaRecorder;
let recordedBlobs;
let systemPrompt = '';
let messages = [];

const recordButton = document.getElementById('recordButton');
recordButton.addEventListener('mousedown', startRecording);
recordButton.addEventListener('touchstart', startRecording);
recordButton.addEventListener('mouseup', stopRecordingAndUpload);
recordButton.addEventListener('mouseleave', stopRecordingAndUpload);
recordButton.addEventListener('touchend', stopRecordingAndUpload);
recordButton.addEventListener('touchcancel', stopRecordingAndUpload);

const stopAudioButton = document.getElementById('stopAudioButton');
stopAudioButton.addEventListener('click', () => window.speechSynthesis.cancel());

const sendTextButton = document.getElementById('sendTextButton');
sendTextButton.addEventListener('click', sendTextMessage);

const textInput = document.getElementById('textInput');
textInput.addEventListener('keypress', async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        window.speechSynthesis.cancel();
        await sendTextMessage();
    }
});

const copySystemPromptToClipboard = () => navigator.clipboard.writeText(getSystemPrompt());
const systemPromptCopyButton = document.getElementById('systemPromptCopyButton');
systemPromptCopyButton.addEventListener('mouseup', copySystemPromptToClipboard);
systemPromptCopyButton.addEventListener('touchend', copySystemPromptToClipboard);

function cloneTemplate(className) {
    const template = document.querySelector(`#templateLibrary > .${className}`);
    if (!template) throw new Error(`Template not found: ${className}`);
    return template.cloneNode(true);
}

const showOptions = document.getElementById('showOptions');
showOptions.addEventListener('click', (event) => {
    event.preventDefault();
    document.getElementById('optionsReveal').classList.toggle('hidden');
});

const optionsInput = document.getElementById('options');
const OPTIONS_STORAGE_KEY = 'whispergpt-options';
if (window.localStorage.getItem(OPTIONS_STORAGE_KEY)) {
    optionsInput.value = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
}
optionsInput.addEventListener('focusout', () => {
    try {
        const options = JSON.parse(document.getElementById('options').value.trim());
        optionsInput.classList.remove('error');
        window.localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options, null, 4));
    } catch (error) {
        optionsInput.classList.add('error');
        console.error('Failed to parse options:', error);
    }
});

const promptCache = {};
let selectedPrompts = ['dan', 'image'];

async function initMediaRecorder() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    recordedBlobs = [];

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedBlobs.push(event.data);
        }
    };
}

function startRecording() {
    window.speechSynthesis.cancel();

    if (mediaRecorder && mediaRecorder.state === 'recording') return;

    recordButton.classList.add('recording');

    initMediaRecorder().then(() => {
        mediaRecorder.start();
    }).catch((error) => {
        console.error('Error initializing media recorder:', error);
        resetRecordButton(); // Reset the button if media recorder fails to initialize
    });
}

function displayMessage(username, message, listItem, html, inferId) {
    messages.push({ role: username, content: message });

    // Clear existing contents
    listItem.innerHTML = '';

    const messageElement = cloneTemplate('message');
    messageElement.querySelector('.username').textContent = `${username}: `;
    if (html) {
      messageElement.querySelector('.contents').innerHTML = html;
    } else {
      messageElement.querySelector('.contents').textContent = message;
    }

    const copyButton = messageElement.querySelector('.copyButton');
    const copyMessageToClipboard = () => navigator.clipboard.writeText(message);
    copyButton.addEventListener('mouseup', copyMessageToClipboard);
    copyButton.addEventListener('touchend', copyMessageToClipboard);

    const shareButton = messageElement.querySelector('.shareButton');
    if (inferId) {
        const copyLinkToClipboard = () => navigator.clipboard.writeText(
            `https://synaptek.bio?inferId=${inferId}`)
        shareButton.addEventListener('mouseup', copyLinkToClipboard);
        shareButton.addEventListener('touchend', copyLinkToClipboard);
    } else {
        shareButton.classList.add('hidden');
    }

    // Add alt text to title in server-rendered images, so you can see text by hovering.
    messageElement.querySelectorAll('.contents img').forEach(img => img.title = img.alt);

    listItem.appendChild(messageElement);
}


function createListItemWithSpinner() {
    const listItem = cloneTemplate('listItem');
    document.getElementById('messageList').appendChild(listItem);
    return listItem;
}

let voices;
const LOAD_TIME = 100;
async function loadVoices() {
  voices = await window.speechSynthesis.getVoices();
  if (voices.length) {
    console.log(`Loaded ${voices.length} voices`);
  } else {
    console.log('Voices are not yet ready');
    setTimeout(loadVoices, LOAD_TIME);
  }
}
setTimeout(loadVoices, 0);

const LANG_OVERRIDE = {
  'es': 'es-US',
  'en': 'en-US',
};
async function announceMessage(message, language) {
    return new Promise((resolve) => {
        console.log(`Creating a speech utterance in language ${language}`);
        const utterance = new SpeechSynthesisUtterance(message);

        const chosenVoice = voices.find(v => v.lang.startsWith(LANG_OVERRIDE[language] || language));
        if (chosenVoice) {
          utterance.voice = chosenVoice;
        } else {
          console.error(`No voice found for language ${language}`);
        }

        // Adjust the rate, pitch, and volume
        utterance.rate = 1; // Default is 1, range is 0.1 to 10
        utterance.pitch = 1; // Default is 1, range is 0 to 2
        utterance.volume = 1; // Default is 1, range is 0 to 1

        utterance.onend = () => resolve();

        window.speechSynthesis.speak(utterance);
    });
}

async function stopRecordingAndUpload() {
    if (!mediaRecorder || mediaRecorder.state == 'inactive') return;

    resetRecordButton();

    mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(recordedBlobs, { type: 'audio/webm' });
        const formData = new FormData();

        formData.append('audio', audioBlob);
        formData.append('mimeType', 'audio/webm');

        const listItem = createListItemWithSpinner();

        try {
            const response = await fetch('/transcribe', {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                const transcription = await response.text();
                console.log(`Audio transcribed successfully: ${transcription}`);
                // NOTE: We assume that the transcription is plaintext, no HTML special characters,
                // so it can safely be used as HTML.
                displayMessage('user', transcription, listItem);
            } else {
                console.error('Error uploading audio:', response.statusText);
                listItem.remove(); // Remove the listItem if the upload fails
            }
        } catch (error) {
            console.error('Error uploading audio:', error);
            listItem.remove(); // Remove the listItem if the upload fails
            return;
        }

        // TODO: Re-enable automatic chat responses
        // await requestChatResponse();
    };

    mediaRecorder.stop();
    mediaStream.getTracks().forEach(t => t.stop());
}

// Crude method of escaping user input which might have HTML-unsafe characters
function escapeHTML(unsafeText) {
    let div = document.createElement('div');
    div.innerText = unsafeText;
    return div.innerHTML;
}

function getOptions() {
    try {
        return JSON.parse(document.getElementById('options').value.trim());
    } catch (error) {
        console.error('Failed to parse options:', error);
        return {};
    }
}

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

            if (response.ok) {
                const { html } = await response.json();
                displayMessage('user', message, listItem, html);
            } else {
                console.error('Error rendering message:', response.statusText);
                listItem.remove();
            }
        } catch (error) {
            console.error('Error rendering message:', error);
            listItem.remove();
        }
    } else {
        // TODO: Re-enable automatic chat responses
        await requestChatResponse();
    }
}

function getSystemPrompt() {
    const customPrompt = document.getElementById('systemInput').value;
    return (systemPrompt + '\n\n'+ customPrompt).trim();
}

async function requestChatResponse() {
    const chatListItem = createListItemWithSpinner();

    try {
        const chatArgsResponse = await fetch('/chatArgs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'system', content: getSystemPrompt()}].concat(messages),
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
                displayMessage('assistant', text, chatListItem, html, inferId);
                await announceMessage(text, language);
            });
            // Third response: images are loaded and the full response is available
            chatStream.addEventListener('imagesLoaded', async (event) => {
                const { text, language, html } = JSON.parse(event.data);
                console.log(`Images rendered successfully: ${text}`);
                displayMessage('assistant', text, chatListItem, html, inferId);
                chatStream.close();
                resolve();
            });
        });
    } catch (error) {
        console.error('Error completing chat:', error);
        chatListItem.remove(); // Remove the listItem if the upload fails
        return;
    }
}

function resetRecordButton() {
    recordButton.classList.remove('recording');
}

async function fetchPrompts() {
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

async function fetchBuildTime() {
    // Build time is not available when running locally
    if (window.location.hostname == 'localhost') return;

    try {
        const response = await fetch('/build-time');

        if (response.ok) {
            const creationTime = await response.text();
            document.getElementById('buildTime').textContent = creationTime;
        } else {
            console.error('Error fetching build time:', response.statusText);
        }
    } catch (error) {
        console.error('Error fetching build time:', error);
    }
}


document.addEventListener('DOMContentLoaded', async () => {
    await fetchPrompts();
    await fetchBuildTime();
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId')) {
          const inferId = queryParams.get('inferId');
          const response = await fetch(`/chatLog/${inferId}`);

          if (response.ok) {
              // Clear preset prompts, and set the system prompt.
              selectedPrompts = [];
              updateSystemPrompt();
              Array.from(document.getElementsByClassName('selected')).forEach(e => e.classList.remove('selected'));
              const responseData = await response.json();
              document.getElementById('systemInput').value = responseData.input.messages[0].content;

              // Load messages, except the system message, including the response message.
              const loadMessages = responseData.input.messages.slice(1).concat(
                  responseData.response.choices[0].message);

              // Create list items synchronously, to ensure messages are rendered in the correct
              // order.
              const listItems = loadMessages.map(() => createListItemWithSpinner());

              // Render all the messages server-side, using the already-generated images.
              await Promise.all(loadMessages.map(async (message, messageIndex) => {
                  const response = await fetch('/renderMessage', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          message: message.content,
                          options: getOptions(),
                          generatedImages: responseData.generatedImages,
                      }),
                  });

                  if (response.ok) {
                      const { html } = await response.json();
                      displayMessage(
                          message.role,
                          message.content,
                          listItems[messageIndex],
                          html,
                          // Add the inference link on the last message only. We don't have the
                          // inference IDs for earlier chat responses in the thread.
                          messageIndex === loadMessages.length - 1 ? inferId : undefined);
                  } else {
                      throw new Error('Failed to render message:', response.statusText);
                  };
              }));
          } else {
              console.error('Error fetching chat log:', error);
          }
    }
});

