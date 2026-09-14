import type { ResponseInput, ResponseInputContent } from "openai/resources/responses/responses.js";
import type { Context, Message } from "../types.ts";

// OpenAI's native format keeps recent input before the encrypted checkpoint.
// This is intentionally separate from coding-agent's plaintext tail retention.
const RETAINED_INPUT_TOKENS = 64_000;
// Codex's estimate for resized/auto images. Pi does not send original-detail images.
const IMAGE_TOKENS = 1_844;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TRUNCATED_OUTPUT = "Output exceeded the available model context and was truncated";

function textTokens(text: string): number {
	return Math.ceil(encoder.encode(text).length / 4);
}

function contentTokens(content: { type: string; text?: string }): number {
	return typeof content.text === "string" ? textTokens(content.text) : IMAGE_TOKENS;
}

function truncateText(text: string, tokens: number): string {
	const bytes = encoder.encode(text);
	const marker = "\n[...truncated...]\n";
	const budget = tokens * 4;
	const markerBytes = encoder.encode(marker).length;
	const available = Math.max(0, budget - markerBytes);
	let end = budget < markerBytes ? budget : Math.ceil(available / 2);
	let start = bytes.length - Math.floor(available / 2);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return (
		decoder.decode(bytes.subarray(0, end)) +
		(budget < markerBytes ? "" : marker + decoder.decode(bytes.subarray(start)))
	);
}

export function retainCodexCompactionInput(input: ResponseInput): ResponseInput {
	let remaining = RETAINED_INPUT_TOKENS;
	const retained: ResponseInput = [];
	for (let i = input.length - 1; i >= 0 && remaining > 0; i--) {
		const item = input[i];
		if (!("role" in item) || item.role !== "user") continue;
		const content =
			typeof item.content === "string" ? [{ type: "input_text" as const, text: item.content }] : item.content;
		const tokens = Math.max(
			1,
			content.reduce((sum, part) => sum + contentTokens(part), 0),
		);
		if (tokens <= remaining) {
			retained.push(item);
			remaining -= tokens;
			continue;
		}
		// Codex favors later content within image-containing boundary messages.
		// Text-only messages retain their content order and truncate boundary text in the middle.
		const reverse = content.some((part) => part.type === "input_image");
		const truncated: ResponseInputContent[] = [];
		for (const part of reverse ? [...content].reverse() : content) {
			const cost = contentTokens(part);
			if (cost <= remaining) {
				truncated.push(part);
				remaining -= cost;
			} else if (part.type === "input_text" && remaining > 0) {
				truncated.push({ ...part, text: truncateText(part.text, remaining) });
				remaining = 0;
			} else {
				remaining = 0;
			}
		}
		if (truncated.length > 0) retained.push({ ...item, content: reverse ? truncated.reverse() : truncated });
		break;
	}
	return retained.reverse();
}

function itemTokens(item: ResponseInput[number]): number {
	if ((item.type === "compaction" || item.type === "reasoning") && item.encrypted_content) {
		return Math.ceil(Math.max(0, Math.floor(item.encrypted_content.length * 0.75) - 650) / 4);
	}
	if ("role" in item && "content" in item) {
		if (typeof item.content === "string") return textTokens(item.content);
		return item.content.reduce((sum, part) => sum + ("text" in part ? textTokens(part.text) : IMAGE_TOKENS), 0);
	}
	if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
		return typeof item.output === "string"
			? textTokens(item.output)
			: item.output.reduce((sum, part) => sum + contentTokens(part), 0);
	}
	return textTokens(JSON.stringify(item));
}

export function estimateOpenAINativeCompactionTokens(checkpoint: {
	item: ResponseInput[number];
	retainedInput?: ResponseInput;
}): number {
	return (
		itemTokens(checkpoint.item) + (checkpoint.retainedInput ?? []).reduce((sum, item) => sum + itemTokens(item), 0)
	);
}

function messageTokens(message: Message): number {
	if (typeof message.content === "string") return textTokens(message.content);
	return message.content.reduce((sum, part) => {
		if (part.type === "text") return sum + textTokens(part.text);
		if (part.type === "thinking") return sum + textTokens(part.thinking);
		if (part.type === "toolCall") return sum + textTokens(part.name + JSON.stringify(part.arguments));
		return sum + IMAGE_TOKENS;
	}, 0);
}

/** Rewrite only the request copy, preserving call IDs and durable text/image results. */
export function trimCodexCompactionToolOutputs(
	context: Context,
	checkpointInput: ResponseInput,
	contextWindow: number,
): Context {
	const messages = context.messages.slice();
	let tokens =
		textTokens(context.systemPrompt ?? "") +
		checkpointInput.reduce((sum, item) => sum + itemTokens(item), 0) +
		messages.reduce((sum, message) => sum + messageTokens(message), 0);
	for (let i = messages.length - 1; i >= 0 && tokens > contextWindow; i--) {
		const message = messages[i];
		if (message.role !== "toolResult") break;
		const replacement = { ...message, content: [{ type: "text" as const, text: TRUNCATED_OUTPUT }] };
		tokens += messageTokens(replacement) - messageTokens(message);
		messages[i] = replacement;
	}
	return { ...context, messages };
}
