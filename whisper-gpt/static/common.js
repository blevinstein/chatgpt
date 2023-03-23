
const OPTIONS_STORAGE_KEY = 'whispergpt-options';

const DEFAULT_OPTIONS = {
    chatModel: "gpt-3.5-turbo",
    voiceGender: "Female",
    imageModel: "stableDiffusion",
    imageSize: "512x512",
    imageModelId: "midjourney",
    imageTransformModel: "stableDiffusion_img2img",
    imageTransformModelId: "img2img",
};

// Convenience function for using templates hidden in HTML page
function cloneTemplate(className) {
    const template = document.querySelector(`#templateLibrary > .${className}`);
    if (!template) throw new Error(`Template not found: ${className}`);
    return template.cloneNode(true);
}

// Crude method of escaping user input which might have HTML-unsafe characters
function escapeHTML(unsafeText) {
    let div = document.createElement('div');
    div.innerText = unsafeText;
    return div.innerHTML;
}

async function registerOptionsControls() {
    const showOptions = document.getElementById('showOptions');
    const revealOptions = (event) => {
        event.preventDefault();
        document.getElementById('optionsReveal').classList.toggle('hidden');
        setTimeout(() => showOptions.scrollIntoView(), 10);
    };
    showOptions.addEventListener('mouseup', revealOptions);
    showOptions.addEventListener('touchend', revealOptions);
    const optionsInput = document.getElementById('options');
    if (window.localStorage.getItem(OPTIONS_STORAGE_KEY)) {
        optionsInput.value = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
    } else {
        optionsInput.value = JSON.stringify(DEFAULT_OPTIONS, null, 4);
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
    const resetOptionsButton = document.getElementById('resetOptionsButton');
    const resetOptions = (event) => {
        optionsInput.value = JSON.stringify(DEFAULT_OPTIONS, null, 4);
    };
    resetOptionsButton.addEventListener('mouseup', resetOptions);
    resetOptionsButton.addEventListener('touchend', resetOptions);

    const instructionsResponse = await fetch('/options.txt');
    if (!instructionsResponse.ok) throw instructionsResponse.statusText;
    const instructions = await instructionsResponse.text();
    document.getElementById('optionsInstructions').textContent = instructions;
}

// Fetch options JSON stored in the HTML page
function getOptions() {
    try {
        return JSON.parse(document.getElementById('options').value.trim());
    } catch (error) {
        console.error('Failed to parse options:', error);
        return {};
    }
}
