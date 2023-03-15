let mediaRecorder;
let recordedBlobs;
let messages = [];

const recordButton = document.getElementById('recordButton');
recordButton.addEventListener('mousedown', startRecording);
recordButton.addEventListener('mouseup', stopRecordingAndUpload);
recordButton.addEventListener('mouseleave', stopRecordingAndUpload);

async function initMediaRecorder() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recordedBlobs = [];

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedBlobs.push(event.data);
        }
    };
}

function startRecording() {
    window.speechSynthesis.cancel();

    recordButton.classList.add('recording');
    recordButton.textContent = 'Recording...';

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
    console.error('Voices are not yet ready');
    setTimeout(loadVoices, LOAD_TIME);
  }
}
setTimeout(loadVoices, 0);

async function announceMessage(message, language) {
    return new Promise((resolve) => {
        console.log(`Creating a speech utterance in language ${language}`);
        const utterance = new SpeechSynthesisUtterance(message);

        const chosenVoice = voices.find(v => v.lang.startsWith(language));
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



function stopRecordingAndUpload() {
    if (!mediaRecorder || mediaRecorder.state == 'inactive') return;

    resetRecordButton();

    mediaRecorder.stop();
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

        const chatListItem = createListItemWithSpinner();

        try {
            const chatResponse = await fetch('/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages }),
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
    };
}


function resetRecordButton() {
    recordButton.classList.remove('recording');
    recordButton.textContent = 'Press and hold to record';
}

//const SYSTEM_PROMPT = 'You are a helpful assistant.';
const SYSTEM_PROMPT = 'You are a helpful assistant. Your messages are being conveyed by audio, so keep your responses concise, and elaborate only when requested by the user.';

displayMessage('system', SYSTEM_PROMPT, createListItemWithSpinner());

