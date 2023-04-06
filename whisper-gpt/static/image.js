const blobToBase64 = blob => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise(resolve => {
        reader.onloadend = () => {
            resolve(reader.result);
        };
    });
};

const getUrlForImageId = inferId => `https://whisper-gpt-generated.s3.amazonaws.com/${inferId}.png`;

// Returns a URL or base64-encoded file data representing a single file
async function getFileFromDataTransfer(dataTransfer, allowBlob = false) {
    let imageLoaded = false;
    if (dataTransfer.items && dataTransfer.items.length > 0) {
        const dataItems = await Promise.all(Array.from(dataTransfer.items).map(item => {
            const kind = item.kind;
            const type = item.type;
            if (item.kind === 'string') {
                return new Promise((resolve, reject) => {
                    item.getAsString(string => resolve({ kind, type, string }));
                });
            } else if (item.kind === 'file' && allowBlob) {
                return blobToBase64(item.getAsFile()).then(fileData => ({ kind, type, fileData }));
            } else {
                console.error('Unexpected item kind:', item);
            }
        }));

        for (let { kind, type, string, fileData } of dataItems) {
            if (kind === 'string' && type === 'text/uri-list') {
                // Quick hack to allow easy drag-and-drop of images from gallery
                // TODO: Instead customize the drop payload?
                const imageLogRegex = /https\:\/\/synaptek\.bio\/imageLog\/(\w+)/;
                const match = string.match(imageLogRegex);
                if (match) {
                    return getUrlForImageId(match[1]);
                }
                return string;
            } else if (kind === 'file') {
                return fileData;
            }
        }
    } else if(dataTransfer.files
        && dataTransfer.files.length > 0
        && allowBlob) {
        return await blobToBase64(dataTransfer.files[0]);
    }
}

function setSubjectImage(imageUrl) {
    const img = cloneTemplate('imageSubject');
    img.src = imageUrl;

    // DEBUG
    //img.addEventListener('click', describeImage);

    subjectImage = imageUrl;
    document.getElementById('imageContainer').children[0].replaceWith(img);
    //document.getElementById('uploadImageButton').classList.remove('hidden');
}

async function enableClickToUpload() {
    // Allow click-to-upload images into subject slot
    const uploadInput = document.getElementById('uploadImage');
    uploadInput.addEventListener('change', async (event) => {
        if (event.target.files && event.target.files.length > 0) {
            setSubjectImage(await blobToBase64(event.target.files[0]));
        } else {
            console.error('No image found:', event);
        }
    });
    const startUpload = (event) => {
        event.preventDefault();
        uploadInput.click();
    };
    bindClick(document.getElementById('uploadImageButton'), startUpload);
    bindClick(document.getElementById('imagePlaceholder'), startUpload);
}

async function handleDropImage(event) {
    event.preventDefault();
    try {
        if (!event.dataTransfer) throw 'No dataTransfer in drop event';
        const imageUrl = await getFileFromDataTransfer(event.dataTransfer);
        if (!imageUrl) throw 'No imageUrl found';
        setSubjectImage(imageUrl);
    } catch (error) {
        console.error(error, event);
    }
}

function enableDragAndDrop() {
    const imageContainer = document.getElementById('imageContainer')
    imageContainer.addEventListener('drop', handleDropImage);
    imageContainer.addEventListener('dragover', doNothing);
    imageContainer.addEventListener('dragleave', doNothing);
    imageContainer.addEventListener('dragenter', doNothing);
}

function enableSyntheticDragAndDrop(element, payload) {
    // Prevent default actions on touch, to allow drag-and-drop
    let lastTouch;
    const recordTouch = (event) => {
        if (event.touches && event.touches.length > 0) {
            lastTouch = event.touches[0];
        }
    };
    element.addEventListener('touchstart', recordTouch);
    element.addEventListener('touchmove', recordTouch);
    element.addEventListener('touchend', (event) => {
        const imageContainer = document.getElementById('imageContainer')
        const dropBounds = imageContainer.getBoundingClientRect();
        if (dropBounds.x <= lastTouch.clientX
            && lastTouch.clientX <= dropBounds.x + dropBounds.width
            && dropBounds.y <= lastTouch.clientY
            && lastTouch.clientY <= dropBounds.y + dropBounds.height) {
            console.log(dropBounds);
            console.log(lastTouch);
            setSubjectImage(payload);
        }
    });
}

async function describeImage(event) {
    try {
        const response = await fetch('/interpretImage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inputImage: subjectImage,
                // TODO: add question
                options: getOptions(),
            }),
        });

        if (!response.ok) throw response.statusText;

        // TODO: Return description
        console.log(await response.json());
    } catch (error) {
        console.log('Failed to describe image:', error);
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls();
    registerSystemPromptControls();
    await registerOptionsControls();
    await fetchPrompts(['dan', 'image', 'image_edit', 'json_output']);

    // Display server build time:
    await fetchBuildTime();

    enableDragAndDrop();
    // TODO: Re-enable when url-encoded images are working
    // await enableClickToUpload();

    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId') && queryParams.get('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    } else if (queryParams.has('imageId') && queryParams.get('imageId')) {
        setSubjectImage(getUrlForImageId(queryParams.get('imageId')));
    }
});

