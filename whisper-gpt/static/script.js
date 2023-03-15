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
    recordButton.classList.add('recording');
    recordButton.textContent = 'Recording...';

    initMediaRecorder().then(() => {
        mediaRecorder.start();
    }).catch((error) => {
        console.error('Error initializing media recorder:', error);
        resetRecordButton(); // Reset the button if media recorder fails to initialize
    });
}

function displayMessage(username, message, listItem) {
    messages.push({ role: username, content: message });

    const spinner = listItem.querySelector('.spinner');
    spinner.remove();

    const usernameElement = document.createElement('b');
    usernameElement.textContent = `${username}: `;

    const messageElement = document.createElement('span');
    messageElement.textContent = message;

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

function stopRecordingAndUpload() {
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
                const chat = await chatResponse.text();
                console.log(`Chat response successful: ${chat}`);
                displayMessage('assistant', chat, chatListItem);
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

displayMessage('system', 'You are a helpful assistant.', createListItemWithSpinner());

