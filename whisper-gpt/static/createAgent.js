document.addEventListener('DOMContentLoaded', async () => {
    await registerOptionsControls();
    await fetchPrompts(['dan', 'json_output']);

    // Display server build time:
    await fetchBuildTime();

    // TODO: Load chat state from agent logs
    /*
    const queryParams = new Map(new URLSearchParams(window.location.search).entries());
    if (queryParams.has('inferId') && queryParams.get('inferId')) {
        await fetchChatLogs(queryParams.get('inferId'));
    }
    */

    bindClick(document.getElementById('createAgentButton'), async () => {
        const response = await fetch('/agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemPrompt: await getSystemPrompt(),
                options: getOptions(),
            }),
        });

        if (!response.ok) {
            console.error('Error creating agent:', response.statusText);
            return;
        }

        const { id: agentId } = await response.json();
        if (!agentId) {
            console.error(`No agent ID!: ${await response.json()}`);
            return;
        }
        window.location.assign(`${window.location.origin}/chatAgent?agentId=${agentId}`);
    });
});

