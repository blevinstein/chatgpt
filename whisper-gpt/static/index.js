document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls();
    await registerSystemPromptControls();
    await registerOptionsControls();
    await fetchPrompts(['dan', 'image', 'json_output']);

    // Display server build time:
    await fetchBuildTime();

    // If requested, load chat state from log
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId') && queryParams.get('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
});

