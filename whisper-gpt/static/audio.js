// For recording audio
let mediaStream;
let mediaRecorder;
let recordedBlobs;

// For playing audio
let audioSource;
let stopSpeaking = () => {};

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

function resetRecordButton() {
    recordButton.classList.remove('recording');
}

function startRecording() {
    stopSpeaking();

    if (mediaRecorder && mediaRecorder.state === 'recording') return;

    recordButton.classList.add('recording');

    initMediaRecorder().then(() => {
        mediaRecorder.start();
    }).catch((error) => {
        console.error('Error initializing media recorder:', error);
        resetRecordButton(); // Reset the button if media recorder fails to initialize
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

            if (!response.ok) throw response.statusText;
            const transcription = await response.text();
            console.log(`Audio transcribed successfully: ${transcription}`);
            messages.push({ role: 'user', content: [ transcription ]});
            // NOTE: We assume that the transcription is plaintext, no HTML special characters,
            // so it can safely be used as HTML.
            addChatMessage('user', listItem, escapeHTML(transcription));
            document.getElementById('recordButton').scrollIntoView();
        } catch (error) {
            console.error('Error uploading audio:', error);
            listItem.remove(); // Remove the listItem if the upload fails
            return;
        }
    };

    mediaRecorder.stop();
    mediaStream.getTracks().forEach(t => t.stop());
}

function stopTalking() {
    if (audioSource) {
        audioSource.stop();
    }
}

async function announceMessage(message, language) {
    try {
        const response = await fetch('/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: message,
                language,
                voice: getOptions().voice,
                voiceGender: getOptions().voiceGender,
            }),
        });

        stopSpeaking = () => {
            document.getElementById('stopAudioButton').classList.remove('playing');
            if (audioSource) {
                audioSource.stop();
            }
        };

        if (!response.ok) throw response.statusText;

        const audioContext = new AudioContext();
        const audioBuffer = await audioContext.decodeAudioData(await response.arrayBuffer());
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = audioBuffer;
        audioSource.connect(audioContext.destination);
        audioSource.addEventListener('ended', stopSpeaking);
        audioSource.start();
        document.getElementById('stopAudioButton').classList.add('playing');
    } catch (error) {
        console.error('Failed to speak:', error);
    }
}

function registerAudioButtons() {
    const recordButton = document.getElementById('recordButton');
    recordButton.addEventListener('mousedown', startRecording);
    recordButton.addEventListener('touchstart', startRecording);
    recordButton.addEventListener('mouseup', stopRecordingAndUpload);
    recordButton.addEventListener('mouseleave', stopRecordingAndUpload);
    recordButton.addEventListener('touchend', stopRecordingAndUpload);
    recordButton.addEventListener('touchcancel', stopRecordingAndUpload);

    const stopAudioButton = document.getElementById('stopAudioButton');
    stopAudioButton.addEventListener('mouseup', () => stopSpeaking());
    stopAudioButton.addEventListener('touchend', () => stopSpeaking());

    const muteButton = document.getElementById('muteButton');
    bindClick(muteButton, () => {
        const muted = muteButton.classList.toggle('muted');
        const muteIcon = muteButton.querySelector('i');
        if (muted) {
            muteIcon.classList.remove('fa-volume-up');
            muteIcon.classList.add('fa-volume-off');
        } else {
            muteIcon.classList.add('fa-volume-up');
            muteIcon.classList.remove('fa-volume-off');
        }
    });
}

