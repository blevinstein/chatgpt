document.addEventListener('DOMContentLoaded', async () => {
    // Audio buttons:
    const recordButton = document.getElementById('recordButton');
    recordButton.addEventListener('mousedown', startRecording);
    recordButton.addEventListener('touchstart', startRecording);
    recordButton.addEventListener('mouseup', stopRecordingAndUpload);
    recordButton.addEventListener('mouseleave', stopRecordingAndUpload);
    recordButton.addEventListener('touchend', stopRecordingAndUpload);
    recordButton.addEventListener('touchcancel', stopRecordingAndUpload);
    const stopAudioButton = document.getElementById('stopAudioButton');
    stopAudioButton.addEventListener('mouseup', stopSpeaking);
    stopAudioButton.addEventListener('touchend', stopSpeaking);

    // Text input and chat buttons:
    const sendTextButton = document.getElementById('sendTextButton');
    sendTextButton.addEventListener('mouseup', sendTextMessage);
    sendTextButton.addEventListener('touchend', sendTextMessage);
    const textInput = document.getElementById('textInput');
    textInput.addEventListener('keypress', async (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            stopSpeaking();
            await sendTextMessage();
        }
    });

    // System prompt and controls:
    const systemPromptCopyButton = document.getElementById('systemPromptCopyButton');
    const copySystemPromptToClipboard = () => {
        navigator.clipboard.writeText(getSystemPrompt());
        showMessageBox(systemPromptCopyButton, 'Copied prompt to clipboard!');
    }
    systemPromptCopyButton.addEventListener('mouseup', copySystemPromptToClipboard);
    systemPromptCopyButton.addEventListener('touchend', copySystemPromptToClipboard);
    await fetchPrompts();

    // Options controls:
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

    // Display server build time:
    await fetchBuildTime();

    // If requested, load chat state from log
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
});

