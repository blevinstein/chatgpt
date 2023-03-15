let mediaRecorder;
let recordedBlobs;

const recordButton = document.getElementById('recordButton');
recordButton.addEventListener('mousedown', startRecording);
recordButton.addEventListener('mouseup', stopRecordingAndUpload);

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
    initMediaRecorder().then(() => {
        mediaRecorder.start();
    }).catch((error) => {
        console.error('Error initializing media recorder:', error);
    });
}

function stopRecordingAndUpload() {
    mediaRecorder.stop();
    mediaRecorder.onstop = () => {
        const mimeType = 'audio/webm';
        const audioBlob = new Blob(recordedBlobs, { type: mimeType });
        const formData = new FormData();

        formData.append('audio', audioBlob);
        formData.append('mimeType', mimeType);

        fetch('/upload', {
            method: 'POST',
            body: formData,
        })
        .then((response) => {
            if (response.ok) {
                console.log('Audio uploaded successfully');
            } else {
                console.error('Error uploading audio:', response.statusText);
            }
        })
        .catch((error) => {
            console.error('Error uploading audio:', error);
        });
    };
}
