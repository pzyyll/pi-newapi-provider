import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleGoogle,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai";

type ModelInput = "text" | "image";
type NewApiBackendApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
type NewApiModelApi = typeof NEWAPI_WRAPPER_API;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
type MaxTokensField = "max_tokens" | "max_completion_tokens";
type ThinkingFormat = "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";

interface NewApiModelConfig {
	id: string;
	name: string;
	api?: NewApiModelApi;
	baseUrl?: string;
	thinkingLevelMap?: ThinkingLevelMap;
	reasoning: boolean;
	input: ModelInput[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsDeveloperRole: boolean;
		maxTokensField: MaxTokensField;
		supportsReasoningEffort?: boolean;
		thinkingFormat?: ThinkingFormat;
		sendSessionAffinityHeaders?: boolean;
		sendSessionIdHeader?: boolean;
		supportsLongCacheRetention?: boolean;
	};
}

interface NewApiModelsResponse {
	data?: Array<{ id?: unknown; name?: unknown }>;
}

interface PublicModelMetadata {
	id?: string;
	name?: string;
	reasoning?: boolean;
	input?: ModelInput[];
	contextWindow?: number;
	maxTokens?: number;
}

const NEWAPI_WRAPPER_API = "newapi-gateway" as const;
const PROVIDER_ID = process.env.NEWAPI_PROVIDER_ID?.trim() || "newapi";
const PROVIDER_NAME = process.env.NEWAPI_PROVIDER_NAME?.trim() || "NewAPI Gateway";
const BASE_URL = normalizeGatewayBaseUrl(process.env.NEWAPI_BASE_URL || "http://localhost:3000");
const MODELS_DEV_URL = process.env.NEWAPI_MODELS_DEV_URL?.trim() || "https://models.dev/models.json";

const DEFAULT_CONTEXT_WINDOW = parsePositiveInteger(process.env.NEWAPI_CONTEXT_WINDOW, 128_000);
const DEFAULT_MAX_TOKENS = parsePositiveInteger(process.env.NEWAPI_MAX_TOKENS, 4096);
const DEFAULT_REASONING = parseBoolean(process.env.NEWAPI_REASONING, false);
const DEFAULT_INPUT = parseInputs(process.env.NEWAPI_INPUTS || "text");
const SESSION_ID_HEADER = process.env.NEWAPI_SESSION_ID_HEADER?.trim() || "session_id";
const EXTRA_HEADERS = parseHeaders(process.env.NEWAPI_HEADERS);
const ROUTES_BY_MODEL_ID = new Map<string, { api: NewApiBackendApi; baseUrl: string }>();

const OFFICIAL_MODELS_DEV_PATTERNS: Array<{ provider: string; model: RegExp }> = [
	{ provider: "deepseek", model: /^deepseek/i },
	{ provider: "openai", model: /^(?:gpt|o\d)/i },
	{ provider: "google", model: /^gemini/i },
	{ provider: "anthropic", model: /^claude/i },
	{ provider: "moonshotai", model: /^kimi/i },
	{ provider: "zhipuai", model: /^glm/i },
	{ provider: "minimax", model: /^minimax/i },
	{ provider: "alibaba", model: /^qwen/i },
	{ provider: "xiaomi", model: /^mimo/i },
	{ provider: "xai", model: /^grok/i },
];

export default async function (pi: ExtensionAPI) {
	const publicModelMetadata = await fetchPublicModelMetadata();
	const discoveredModels = await discoverModels(publicModelMetadata);
	const models = discoveredModels.length > 0 ? discoveredModels : modelsFromEnvironment(publicModelMetadata);

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: getOpenAiBaseUrl(),
		apiKey: "$NEWAPI_API_KEY",
		api: NEWAPI_WRAPPER_API,
		streamSimple: streamNewApiGateway,
		...(Object.keys(EXTRA_HEADERS).length > 0 ? { headers: EXTRA_HEADERS } : {}),
		models,
	});
}

function streamNewApiGateway(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const route = ROUTES_BY_MODEL_ID.get(model.id) ?? getModelRoute(model.id, undefined);
			const routedModel = { ...model, api: route.api, baseUrl: route.baseUrl };
			const routedOptions = addSessionIdHeader(options);
			const innerStream = streamBackendApi(route.api, routedModel, context, routedOptions);

			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

function addSessionIdHeader(options: SimpleStreamOptions | undefined): SimpleStreamOptions | undefined {
	const sessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	if (!sessionId) return options;

	return {
		...(options ?? {}),
		headers: {
			...(options?.headers ?? {}),
			[SESSION_ID_HEADER]: sessionId,
		},
	};
}

function streamBackendApi(
	api: NewApiBackendApi,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	switch (api) {
		case "anthropic-messages":
			return streamSimpleAnthropic(model as Model<"anthropic-messages">, context, options);
		case "google-generative-ai":
			return streamSimpleGoogle(model as Model<"google-generative-ai">, context, options);
		case "openai-responses":
			return streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, options);
		case "openai-completions":
			return streamSimpleOpenAICompletions(model as Model<"openai-completions">, context, options);
	}
}

async function discoverModels(publicModelMetadata: Map<string, PublicModelMetadata>): Promise<NewApiModelConfig[]> {
	if (process.env.NEWAPI_FETCH_MODELS === "false") return [];

	const apiKey = process.env.NEWAPI_API_KEY;
	if (!apiKey) return [];

	try {
		const response = await fetch(`${getOpenAiBaseUrl()}/models`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				...EXTRA_HEADERS,
			},
		});

		if (!response.ok) {
			console.warn(`[${PROVIDER_ID}] Failed to fetch models: ${response.status} ${await response.text()}`);
			return [];
		}

		const payload = (await response.json()) as NewApiModelsResponse;
		const ids = (payload.data ?? [])
			.map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
			.filter((id) => id.length > 0);

		return [...new Set(ids)].sort().map((id) => toProviderModel(id, publicModelMetadata));
	} catch (error) {
		console.warn(`[${PROVIDER_ID}] Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function modelsFromEnvironment(publicModelMetadata: Map<string, PublicModelMetadata>): NewApiModelConfig[] {
	const ids = (process.env.NEWAPI_MODELS || "gpt-4o-mini")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);

	return [...new Set(ids)].map((id) => toProviderModel(id, publicModelMetadata));
}

function toProviderModel(id: string, publicModelMetadata: Map<string, PublicModelMetadata>): NewApiModelConfig {
	const metadata = findPublicModelMetadata(id, publicModelMetadata);
	const route = getModelRoute(id, metadata);
	ROUTES_BY_MODEL_ID.set(id, route);
	const reasoning =
		metadata?.reasoning ?? (DEFAULT_REASONING || /(?:^|[-_/])(o\d|reasoner|r1|thinking)(?:$|[-_/])/i.test(id));
	const compat = getModelCompat(id, metadata, reasoning);
	const thinkingLevelMap = getThinkingLevelMap(id, metadata);

	return {
		id,
		name: metadata?.name ?? formatModelName(id),
		api: NEWAPI_WRAPPER_API,
		baseUrl: route.baseUrl,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		reasoning,
		input: metadata?.input ?? DEFAULT_INPUT,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: metadata?.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat,
	};
}

async function fetchPublicModelMetadata(): Promise<Map<string, PublicModelMetadata>> {
	const metadataById = new Map<string, PublicModelMetadata>();
	if (process.env.NEWAPI_FETCH_MODEL_METADATA === "false") return metadataById;

	try {
		const response = await fetch(MODELS_DEV_URL);
		if (!response.ok) {
			console.warn(`[${PROVIDER_ID}] Failed to fetch public model metadata: ${response.status} ${response.statusText}`);
			return metadataById;
		}

		const payload = asRecord(await response.json());
		if (!payload) return metadataById;

		for (const [key, value] of Object.entries(payload)) {
			if (!isOfficialModelsDevId(key)) continue;

			const model = asRecord(value);
			if (!model) continue;

			const metadata = toPublicModelMetadata(model);
			for (const lookupId of getPublicModelLookupIds(key, metadata.id ?? key)) {
				metadataById.set(normalizeModelLookupId(lookupId), metadata);
			}
		}
	} catch (error) {
		console.warn(
			`[${PROVIDER_ID}] Failed to fetch public model metadata: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return metadataById;
}

function toPublicModelMetadata(model: Record<string, unknown>): PublicModelMetadata {
	const metadata: PublicModelMetadata = {};
	const id = readString(model, "id");
	const name = readString(model, "name");
	const modalities = asRecord(model.modalities);
	const limit = asRecord(model.limit);
	const input = parsePublicModelInputs(modalities?.input);
	const contextWindow = readPositiveInteger(limit, "context");
	const maxTokens = readPositiveInteger(limit, "output");

	if (id) metadata.id = id;
	if (name) metadata.name = name;
	if (typeof model.reasoning === "boolean") metadata.reasoning = model.reasoning;
	if (input) metadata.input = input;
	if (contextWindow) metadata.contextWindow = contextWindow;
	if (maxTokens) metadata.maxTokens = maxTokens;

	return metadata;
}

function findPublicModelMetadata(
	id: string,
	publicModelMetadata: Map<string, PublicModelMetadata>,
): PublicModelMetadata | undefined {
	return (
		publicModelMetadata.get(normalizeModelLookupId(id)) ??
		publicModelMetadata.get(normalizeModelLookupId(stripProviderPrefix(id)))
	);
}

function getPublicModelLookupIds(key: string, id: string): string[] {
	return [
		...new Set([key, id, stripProviderPrefix(key), stripProviderPrefix(id)].filter((lookupId) => lookupId.length > 0)),
	];
}

function isOfficialModelsDevId(id: string): boolean {
	const slashIndex = id.indexOf("/");
	if (slashIndex <= 0 || slashIndex === id.length - 1) return false;

	const provider = id.slice(0, slashIndex).toLowerCase();
	const model = id.slice(slashIndex + 1);
	return OFFICIAL_MODELS_DEV_PATTERNS.some((pattern) => pattern.provider === provider && pattern.model.test(model));
}

function stripProviderPrefix(id: string): string {
	const slashIndex = id.indexOf("/");
	return slashIndex === -1 ? id : id.slice(slashIndex + 1);
}

function normalizeModelLookupId(id: string): string {
	return id.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveInteger(record: Record<string, unknown> | undefined, key: string): number | undefined {
	if (!record) return undefined;

	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parsePublicModelInputs(value: unknown): ModelInput[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const inputs = value.filter((input): input is ModelInput => input === "text" || input === "image");
	return inputs.length > 0 ? [...new Set(inputs)] : undefined;
}

function getModelRoute(
	id: string,
	metadata: PublicModelMetadata | undefined,
): { api: NewApiBackendApi; baseUrl: string } {
	const candidates = getModelRouteCandidates(id, metadata);

	if (candidates.some(isClaudeModelId)) {
		return { api: "anthropic-messages", baseUrl: BASE_URL };
	}

	if (candidates.some(isGoogleModelId)) {
		return { api: "google-generative-ai", baseUrl: getGatewayBaseUrl("v1beta") };
	}

	if (candidates.some(supportsOpenAiResponsesApi)) {
		return { api: "openai-responses", baseUrl: getOpenAiBaseUrl() };
	}

	return { api: "openai-completions", baseUrl: getOpenAiBaseUrl() };
}

function getModelRouteCandidates(id: string, metadata: PublicModelMetadata | undefined): string[] {
	return [
		...new Set(
			[
				id,
				stripProviderPrefix(id),
				metadata?.id,
				metadata?.id ? stripProviderPrefix(metadata.id) : undefined,
				metadata?.name,
			]
				.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
				.map(normalizeModelLookupId),
		),
	];
}

function isClaudeModelId(id: string): boolean {
	return id.startsWith("anthropic/claude") || id.startsWith("claude");
}

function isGoogleModelId(id: string): boolean {
	return id.startsWith("google/gemini") || id.startsWith("gemini");
}

function supportsOpenAiResponsesApi(id: string): boolean {
	return id.startsWith("openai/gpt-5") || id.startsWith("gpt-5") || /^openai\/o\d/.test(id) || /^o\d/.test(id);
}

function getModelCompat(
	id: string,
	metadata: PublicModelMetadata | undefined,
	reasoning: boolean,
): NewApiModelConfig["compat"] {
	const candidates = getModelRouteCandidates(id, metadata);
	const thinkingFormat = getThinkingFormat(candidates);

	return {
		supportsDeveloperRole: candidates.some(isOpenAiModelId),
		maxTokensField: getMaxTokensField(candidates),
		...(reasoning ? { supportsReasoningEffort: supportsReasoningEffort(candidates) } : {}),
		...(thinkingFormat ? { thinkingFormat } : {}),
	};
}

function getThinkingFormat(candidates: string[]): ThinkingFormat | undefined {
	if (candidates.some(isDeepSeekModelId)) return "deepseek";
	if (candidates.some(isQwenModelId)) return "qwen";
	if (candidates.some(isGlmModelId)) return "zai";

	return undefined;
}

function getThinkingLevelMap(id: string, metadata: PublicModelMetadata | undefined): ThinkingLevelMap | undefined {
	const candidates = getModelRouteCandidates(id, metadata);
	if (!candidates.some(isDeepSeekModelId)) return undefined;

	return {
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: "max",
	};
}

function getMaxTokensField(candidates: string[]): MaxTokensField {
	if (candidates.some(usesMaxTokensField)) return "max_tokens";
	return "max_completion_tokens";
}

function supportsReasoningEffort(candidates: string[]): boolean {
	return candidates.some(isOpenAiReasoningModelId) || candidates.some(isDeepSeekModelId);
}

function isOpenAiModelId(id: string): boolean {
	return id.startsWith("openai/gpt") || id.startsWith("gpt") || /^openai\/o\d/.test(id) || /^o\d/.test(id);
}

function isOpenAiReasoningModelId(id: string): boolean {
	return id.startsWith("openai/gpt-5") || id.startsWith("gpt-5") || /^openai\/o\d/.test(id) || /^o\d/.test(id);
}

function usesMaxTokensField(id: string): boolean {
	return (
		id.startsWith("moonshotai/kimi") ||
		id.startsWith("kimi") ||
		id.startsWith("minimax/") ||
		id.startsWith("minimax") ||
		id.startsWith("zhipuai/glm") ||
		id.startsWith("glm") ||
		id.startsWith("alibaba/qwen") ||
		id.startsWith("qwen") ||
		id.startsWith("deepseek/deepseek") ||
		id.startsWith("deepseek")
	);
}

function isDeepSeekModelId(id: string): boolean {
	return id.startsWith("deepseek/deepseek") || id.startsWith("deepseek");
}

function isQwenModelId(id: string): boolean {
	return id.startsWith("alibaba/qwen") || id.startsWith("qwen");
}

function isGlmModelId(id: string): boolean {
	return id.startsWith("zhipuai/glm") || id.startsWith("glm");
}

function getOpenAiBaseUrl(): string {
	return getGatewayBaseUrl("v1");
}

function getGatewayBaseUrl(path: string): string {
	return `${BASE_URL}/${path.replace(/^\/+/, "")}`;
}

function normalizeGatewayBaseUrl(value: string): string {
	return normalizeBaseUrl(value).replace(/\/v1(?:beta)?$/i, "");
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
	return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseInputs(value: string): ModelInput[] {
	const inputs = value
		.split(",")
		.map((input) => input.trim())
		.filter((input): input is ModelInput => input === "text" || input === "image");
	return inputs.length > 0 ? [...new Set(inputs)] : ["text"];
}

function parseHeaders(value: string | undefined): Record<string, string> {
	if (!value) return {};

	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

		return Object.fromEntries(
			Object.entries(parsed)
				.filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
				.map(([key, headerValue]) => [key, headerValue]),
		);
	} catch {
		return {};
	}
}

function formatModelName(id: string): string {
	return id
		.split(/[._/-]+/)
		.filter(Boolean)
		.map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
		.join(" ");
}
