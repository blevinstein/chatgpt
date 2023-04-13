document.addEventListener('DOMContentLoaded', async () => {
    registerAudioButtons();
    registerChatControls(sendAgentMessage);
    await registerOptionsControls();

    // Display server build time:
    await fetchBuildTime();

    // Load chat state from server
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('agentId') && queryParams.get('agentId')) {
        await fetchAgent(queryParams.get('agentId'));
    }
});

