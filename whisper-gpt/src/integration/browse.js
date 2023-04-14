
import axios from 'axios';
import fs from 'fs';
import { parse } from 'node-html-parser';
import { encode, decode } from 'gpt-3-encoder';

import { generateChatCompletion } from './chat.js';

export async function fetchPage(url) {
    console.log(`Triggered browse to URL: ${url}`);
		try {
				const response = await axios.get(url);
				const rawHtml = response.data;
        const root = parse(rawHtml);
        // Remove raw data that is not useful
        root.querySelectorAll('script, style, noscript, head, svg > *').forEach(s => s.remove());
        root.querySelectorAll('img[src*="base64"]').forEach(s => s.removeAttribute('src'));
        return { html: root.toString(), text: root.text };
		} catch (error) {
				console.error(`Error browsing URL ${url}: ${error.message}`);
				throw error;
		}
}

export function chunkText(text, tokensPerChunk = 6000) {
    let tokensRemaining = encode(text);
    const chunks = [];
    while (tokensRemaining.length > 0) {
        chunks.push(decode(tokensRemaining.slice(0, tokensPerChunk)));
        tokensRemaining = tokensRemaining.slice(tokensPerChunk);
    }
    return chunks;
}

const DEFAULT_TASK = 'Summarize the contents of the page.';

const createPromptFromFile = async ({ filePath, task = DEFAULT_TASK, url }) => {
    const pattern = await fs.promises.readFile(filePath, { encoding: 'utf-8' });
    return pattern.replaceAll(/{{task}}/g, task).replaceAll(/{{url}}/g, url);
};

export async function scanPage({ html, url, task, options, user }) {
    if (typeof html !== 'string' || html.length === 0) throw new Error(`Unexpected input: ${html}`);
    const textChunks = chunkText(html);
    const inferIds = [];
    const summaryChunks = [];

    // TODO: If the answer is found in the middle of the page, terminate early, don't summarize the
    // remaining chunks.
    console.log(`Summarizing page in ${textChunks.length} chunks.`);
    const summaryPrompt = await createPromptFromFile({
        filePath: 'hidden_prompt/summarize.txt',
        task,
        url,
    });
    for (let textChunk of textChunks) {
        const { inferId, reply } = await generateChatCompletion({
            messages: [
                { role: 'system', content: [ summaryPrompt ] },
                { role: 'user', content: [ textChunk ] },
            ],
            options,
            user,
        });
        inferIds.push(inferId);
        summaryChunks.push(reply);
    }

    if (summaryChunks.length > 1) {
        const mergePrompt = await createPromptFromFile({
            filePath: 'hidden_prompt/merge_summary.txt',
            task,
            url,
        });
        const { inferId, reply: summary } = await generateChatCompletion({
            messages: [
                { role: 'system', content: [ mergePrompt ] },
                { role: 'user', content: summaryChunks },
            ],
            options,
            user,
        });
        inferIds.push(inferId);
        return { inferIds, summary };
    } else {
        return { inferIds, summary: summaryChunks[0] };
    }

}
