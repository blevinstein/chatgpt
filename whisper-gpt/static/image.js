const blobToBase64 = blob => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise(resolve => {
        reader.onloadend = () => {
            resolve(reader.result);
        };
    });
};

document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls();
    registerSystemPromptControls();
    registerOptionsControls();

    // Display server build time:
    await fetchBuildTime();

    const updateImage = async (event) => {
        event.preventDefault();

        window.event = event;

        let file;
        if (event.dataTransfer.items && event.dataTransfer.items.length > 0) {
            file = event.dataTransfer.items[0].getAsFile();
        } else if(event.dataTransfer.files && event.dataTransfer.files.length > 0) {
            file = event.dataTransfer.files[0];
        }
        if (!file) {
            console.error('No file data:', event);
            return;
        }

        const img = cloneTemplate('imageSubject');
        img.src = await blobToBase64(file);
        document.getElementById('imageContainer').children[0].replaceWith(img);
    };
    document.getElementById('imageContainer').ondrop = updateImage;
    document.getElementById('imageContainer').ondragover = (event) => event.preventDefault();

    // If requested, load chat state from log
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
});

