const blobToBase64 = blob => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise(resolve => {
        reader.onloadend = () => {
            resolve(reader.result);
        };
    });
};

// Returns a URL or base64-encoded file data representing a single file
async function getFileFromDropEvent(event) {
    let imageLoaded = false;
    if (event.dataTransfer.items && event.dataTransfer.items.length > 0) {
        const dataItems = await Promise.all(Array.from(event.dataTransfer.items).map(item => {
            const kind = item.kind;
            const type = item.type;
            if (item.kind === 'string') {
                return new Promise((resolve, reject) => {
                    item.getAsString(string => resolve({ kind, type, string }));
                });
            } else if (item.kind === 'file') {
                return blobToBase64(item.getAsFile()).then(fileData => ({ kind, type, fileData }));
            } else {
                console.log('Unexpected item kind:', item);
            }
        }));

        for (let { kind, type, string, fileData } of dataItems) {
            if (kind === 'string' && type === 'text/uri-list') {
                return string;
            } else if (kind === 'file') {
                return fileData;
            }
        }
    } else if(event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        return await blobToBase64(event.dataTransfer.files[0]);
    }
}

function setSubjectImage(imageUrl) {
    const img = cloneTemplate('imageSubject');
    img.src = imageUrl;
    document.getElementById('imageContainer').children[0].replaceWith(img);
    document.getElementById('uploadImageButton').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls();
    registerSystemPromptControls();
    registerOptionsControls();

    // Display server build time:
    await fetchBuildTime();

    // Allow drag-and-drop images into subject slot
    const handleDropImage = async (event) => {
        event.preventDefault();
        const imageUrl = await getFileFromDropEvent(event);
        if (imageUrl) {
            setSubjectImage(imageUrl);
        } else {
            console.error('No image found', event);
        }
    };
    const doNothing = (event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    const imageContainer = document.getElementById('imageContainer')
    imageContainer.addEventListener('drop', handleDropImage);
    imageContainer.addEventListener('dragover', doNothing);
    imageContainer.addEventListener('dragleave', doNothing);
    imageContainer.addEventListener('dragenter', doNothing);

    // Allow click-to-upload images into subject slot
    const uploadInput = document.getElementById('uploadImage');
    uploadInput.addEventListener('change', async (event) => {
        if (event.target.files && event.target.files.length > 0) {
            setSubjectImage(await blobToBase64(event.target.files[0]));
        } else {
            console.log('No image found:', event);
        }
    });
    const startUpload = (event) => {
        event.preventDefault();
        uploadInput.click();
    };
    const uploadImageButton = document.getElementById('uploadImageButton');
    uploadImageButton.addEventListener('mouseup', startUpload);
    uploadImageButton.addEventListener('touchend', startUpload);
    const imagePlaceholder = document.getElementById('imagePlaceholder');
    imagePlaceholder.addEventListener('mouseup', startUpload);
    imagePlaceholder.addEventListener('touchend', startUpload);

    // TODO: Support restoring state from logs
    /*
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
    */
});

