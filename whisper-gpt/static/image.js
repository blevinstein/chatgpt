document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls();
    registerSystemPromptControls();
    registerOptionsControls();

    // Display server build time:
    await fetchBuildTime();

    // If requested, load chat state from log
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
});

