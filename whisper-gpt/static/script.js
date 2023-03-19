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

document.addEventListener('DOMContentLoaded', async () => {
    await fetchPrompts();
    await fetchBuildTime();
});

const promptCache = {};
let selectedPrompts = ['dan', 'image', 'audio'];

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

function displayMessage(username, message, listItem, html) {
    messages.push({ role: username, content: message });

    const spinner = listItem.querySelector('.spinner');
    spinner.remove();

    const usernameElement = document.createElement('b');
    usernameElement.textContent = `${username}: `;

    const messageElement = document.createElement('span');
    if (html) {
      messageElement.innerHTML = html;
    } else {
      messageElement.textContent = message;
    }

    listItem.appendChild(usernameElement);
    listItem.appendChild(messageElement);
}


function createListItemWithSpinner() {
    const listItem = document.createElement('li');
    const spinner = document.createElement('div');
    spinner.classList.add('spinner');
    listItem.appendChild(spinner);

    const messageList = document.getElementById('messageList');
    messageList.appendChild(listItem);

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

        // Add transcription to messages
        try {
            const response = await fetch('/transcribe', {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                const transcription = await response.text();
                console.log(`Audio transcribed successfully: ${transcription}`);
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

async function sendTextMessage() {
    const message = textInput.value.trim();
    textInput.value = '';
    if (message.length > 0) {
        try {
            const listItem = createListItemWithSpinner();

            const response = await fetch('/renderMessage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
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

async function requestChatResponse() {
    const chatListItem = createListItemWithSpinner();

    try {
        const customPrompt = document.getElementById('systemInput').value;
        const fullPrompt = systemPrompt + '\n\n'+ customPrompt;
        const chatResponse = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'system', content: fullPrompt}].concat(messages),
            }),
        });

        if (chatResponse.ok) {
            const { text: chat, language, html } = await chatResponse.json();
            console.log(`Chat response successful: ${chat}`);
            displayMessage('assistant', chat, chatListItem, html);
            announceMessage(chat, language);
        } else {
            console.error('Error completing chat:', chatResponse.statusText);
            chatListItem.remove();
        }
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
            const button = document.createElement('button');
            button.classList.add('promptButton');
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



