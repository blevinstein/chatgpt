const recordButton = document.getElementById("recordButton");
const stopButton = document.getElementById("stopButton");
const uploadButton = document.getElementById("uploadButton");

let mediaRecorder;
let recordedBlobs;

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
uploadButton.addEventListener("click", uploadRecording);

async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recordedBlobs = [];

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedBlobs.push(event.data);
        }
    };
    mediaRecorder.start();
    recordButton.disabled = true;
    stopButton.disabled = false;
}

function stopRecording() {
    mediaRecorder.stop();
    stopButton.disabled = true;
    uploadButton.disabled = false;
}

async function uploadRecording() {
    const mimeType = "audio/webm"; // Update this based on your desired format
    const blob = new Blob(recordedBlobs, { type: mimeType });
    const formData = new FormData();
    formData.append("audio", blob);
    formData.append("mimeType", mimeType); // Send the mimeType to the server

    const response = await fetch("http://localhost:3000/upload", {
        method: "POST",
        body: formData,
    });

    if (response.ok) {
        alert("Upload successful!");
    } else {
        alert("Upload failed.");
    }

    recordButton.disabled = false;
    uploadButton.disabled = true;
}


