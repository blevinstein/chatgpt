
import axios from 'axios';
import { parse } from 'node-html-parser';
import { encode, decode } from 'gpt-3-encoder';

import { generateChatCompletion } from './chat.js';

export async function browsePage(url) {
    console.log(`Triggered browse to URL: ${url}`);
		try {
				const response = await axios.get(url);
				const rawHtml = response.data;
        const root = parse(rawHtml);
        root.querySelectorAll('script, style, noscript, head, svg > *').forEach(s => s.remove());
        const links = root.querySelectorAll('a').map(a => ({ href: a.getAttribute('href'), text: a.text.trim() }));
        return { html: root.toString(), text: root.text, links };
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

const summarizePrompt = (question) => question
    ? `Try to answer this question: ${question}\n\nIf you cannot answer the question, just summarize the text.`
    : 'Summarize the given text.';

export async function summarizeText({ text, question, options, user }) {
    if (typeof text !== 'string') throw new Error(`Unexpected input: ${text}`);
    const textChunks = chunkText(text);
    const inferIds = [];
    const summaryChunks = [];

    console.log(`Summarizing text in ${textChunks.length} chunks.`);
    if (textChunks.length > 1) {
        for (let textChunk of textChunks) {
            const { inferId, reply } = await generateChatCompletion({
                messages: [
                    { role: 'system', content: [ summarizePrompt(question) ] },
                    { role: 'user', content: [ textChunk ] },
                ],
                options,
                user,
            });
            inferIds.push(inferId);
            summaryChunks.push(reply);
        }
    } else {
        summaryChunks.push(textChunks[0]);
    }

    const { inferId, reply: summary } = await generateChatCompletion({
        messages: [
            { role: 'system', content: [ summarizePrompt(question) ] },
            { role: 'user', content: [ summaryChunks.join('\n') ] },
        ],
        options,
        user,
    });
    inferIds.push(inferId);

    return { inferIds, summary };
}
