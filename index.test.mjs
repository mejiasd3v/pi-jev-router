import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";

// Match Pi's extension loader: the pi-ai root resolves to its compatibility API.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piAi = piRequire.resolve.paths("@earendil-works/pi-ai")
	.map((path) => join(path, "@earendil-works/pi-ai/dist/compat.js")).find(existsSync);
assert.ok(piAi, "Pi's installed pi-ai package must be available");
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-ai": piAi } });
const { default: extension, parseConfig, routingInput, effortPayload, customEvaluationModel } = await jiti.import("./index.ts");
const { convertToLlm } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import(pathToFileURL(piAi));
// Never read or write the developer's settings.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), "jev-settings-"));
const settingsPath = join(agentDir, "settings.json");
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});
const FAST = "openai-codex/gpt-5.6-luna";
const DEEP = "openai-codex/gpt-6-astra";
const usage = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 } };
const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const context = (text = "Fix a typo", timestamp = 1) => ({ systemPrompt: "PRIVATE SYSTEM INSTRUCTIONS", tools: [], messages: [user(text, timestamp)] });

async function harness({ refs = [FAST, DEEP], gatewayKey = true, backendError = false, incomplete = false, auth, history = [], sessionId = "main", responsesPayload = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const calls = [], entries = structuredClone(history), notices = [];
	const models = refs.map((ref) => ({
		provider: ref.split("/")[0], id: ref.slice(ref.indexOf("/") + 1), name: ref,
		api: "openai-codex-responses", baseUrl: "https://example.invalid",
		contextWindow: 272000, maxTokens: 128000, input: ["text", "image"], reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" }, cost: usage.cost,
	}));
	let registration;
	const backend = {
		streamSimple(model, ctx, options) {
			const output = createAssistantMessageEventStream();
			const message = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
				usage, timestamp: 2, stopReason: backendError ? "error" : "toolUse",
				...(backendError ? { errorMessage: "Backend failure" } : {}),
			};
			void (async () => {
				const body = responsesPayload ? { model: model.id, reasoning: { effort: options.reasoning }, input: ctx.messages.map((message) => ({ role: message.role, content: message.content })) } : { model: model.id };
				let payload;
				try { payload = await options.onPayload?.(body, model); }
				catch (error) {
					message.stopReason = "error";
					message.errorMessage = error.message;
					output.push({ type: "error", reason: "error", error: message });
					output.end(message);
					return;
				}
				calls.push({ model, context: ctx, options, message, payload });
				output.push({ type: "start", partial: message });
				output.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
				if (!incomplete) output.push(backendError ? { type: "error", reason: "error", error: message } : { type: "done", reason: "toolUse", message });
				output.end(message);
			})();
			return output;
		},
	};
	const registry = {
		getAvailable: () => models,
		getProvider: () => backend,
		getProviderAuth: async (provider) => {
			assert.equal(provider, "vercel-ai-gateway");
			return gatewayKey ? { auth: { apiKey: "gateway-test-key" } } : undefined;
		},
		getProviderAuthStatus: () => ({ configured: gatewayKey }),
		getApiKeyAndHeaders: auth ?? (async () => ({ ok: true, apiKey: "codex-test-key", headers: { "x-backend": "yes" }, env: { BACKEND: "yes" }, baseUrl: "https://backend.example.invalid" })),
		find: (provider, id) => provider === "auto" ? { ...registration.models[0], provider, api: registration.api, baseUrl: registration.baseUrl } : models.find((model) => model.provider === provider && model.id === id),
	};
	const ctx = {
		cwd: agentDir,
		getSystemPrompt: () => "PRIVATE SYSTEM INSTRUCTIONS",
		modelRegistry: registry,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries.map(({ name, data }) => ({ type: "custom", customType: name, data })),
			getBranch: () => entries.map(({ name, data }) => ({ type: "custom", customType: name, data })),
			buildContextEntries: () => entries.map(({ name, data }) => ({ type: "custom", customType: name, data })),
		},
		ui: { setStatus() {}, notify: (...args) => notices.push(args) },
	};
	const pi = {
		registerProvider(provider, value) {
			assert.equal(provider, "auto");
			registration = value;
			// Pi refreshes the active model from the registry without a model_select event.
			if (ctx.model?.provider === provider) ctx.model = registry.find(provider, ctx.model.id);
		},
		on(name, handler) { handlers.set(name, handler); },
		appendEntry: (name, data) => entries.push({ name, data }),
		registerCommand(name, command) { commands.set(name, command); },
		setModel: async (model) => { ctx.model = model; return true; },
	};
	extension(pi);
	ctx.model = registry.find("auto", "jev");
	await handlers.get("session_start")({}, ctx);
	return {
		calls, entries, notices, models, ctx, handlers, commands,
		stream: (input = context(), options = {}) => registration.streamSimple(ctx.model, input, { sessionId, apiKey: "router-key", headers: { Authorization: "router-secret" }, env: { ROUTER_SECRET: "private" }, ...options }),
	};
}

const liveFetch = globalThis.fetch;

function mockGateway(t, respond = () => FAST) {
	const previous = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, options) => {
		assert.match(String(url), /^https:\/\/ai-gateway\.vercel\.sh\/.+\/evaluation-model$/);
		assert.equal(new Headers(options.headers).get("authorization"), "Bearer gateway-test-key");
		assert.equal(new Headers(options.headers).get("ai-model-id"), "typesafe-ai/jev");
		const body = JSON.parse(options.body);
		requests.push(body);
		const result = await respond(options, body);
		if (result instanceof Response) return result;
		if (body.questions.effort) return Response.json({ answers: { effort: { type: "choice", choice: typeof result === "string" ? result : result.thinking } }, usage: { inputTokens: 1000, outputTokens: 0 } });
		const desired = typeof result === "string" ? { target: result } : result;
		const choice = Object.entries(body.questions.route.criteria).find(([, profile]) =>
			profile.model === desired.target && (desired.thinking === undefined || profile.thinking === desired.thinking))?.[0] ?? "unoffered-profile";
		return Response.json({ answers: { route: { type: "choice", choice } }, usage: { inputTokens: 1000, outputTokens: 0 } });
	};
	t.after(() => { globalThis.fetch = previous; });
	return requests;
}

function configureSkills(t, extra = {}) {
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: {
		options: { [FAST]: { description: "Routine" } }, fallback: FAST, skills: true, ...extra,
	} }));
	t.after(() => rmSync(settingsPath, { force: true }));
}

function skillFixture(name, extra = {}) {
	const filePath = join(agentDir, `${name}.md`);
	writeFileSync(filePath, `---\nname: ${name}\ndescription: Test skill\n---\nPRIVATE BODY for ${name}.\n`);
	return { name, description: `Use ${name} for its specific task.`, filePath, baseDir: agentDir, disableModelInvocation: false, ...extra };
}

async function setSkills(h, skills) {
	await h.handlers.get("before_agent_start")({ systemPromptOptions: { skills } }, h.ctx);
}

function mockSkillGateway(t, probabilities = {}) {
	return mockGateway(t, (_options, body) => Response.json({
		answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, {
			type: "boolean", probability: probabilities[question.criteria.true.name] ?? 0.95,
		}])), usage: { inputTokens: 1000, outputTokens: 0 },
	}));
}

const skillContext = (h, messages) => h.handlers.get("context")({ messages }, h.ctx);

test("custom endpoint routes without Gateway credentials and validates answers", async (t) => {
	configureSkills(t, { apiUrl: "https://local.invalid/score", options: { [FAST]: { description: "Routine" }, [DEEP]: { description: "Complex" } }, fallback: DEEP, skills: false });
	const previous = globalThis.fetch;
	t.after(() => { globalThis.fetch = previous; });
	const requests = [];
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "https://local.invalid/score");
		assert.equal(new Headers(options.headers).has("authorization"), false);
		assert.equal(options.redirect, "error");
		const row = JSON.parse(options.body); requests.push(row);
		return Response.json({ id: row.id, option_ids: row.options.map(o => o.id), probabilities: [0.9, 0.1], input_tokens: 42 });
	};
	const h = await harness({ gatewayKey: false });
	await h.stream().result();
	assert.equal(h.calls[0].model.id, FAST.split("/")[1]);
	assert.equal(h.entries.find(e => e.name === "jev-route").data.source, "jev");
	assert.equal(h.entries.find(e => e.name === "jev-route").data.estimatedCost, 0);
	assert.equal(requests.length, 1);
	const model = customEvaluationModel("https://local.invalid/score");
	const result = await model.doEvaluate({ state: "evidence", questions: { needed: { type: "boolean", instructions: "Needed?", criteria: { true: { description: "yes" }, false: "no" } } } });
	assert.equal(result.answers.needed.probability, 0.9);
	assert.equal(requests[1].options[0].description, '{"description":"yes"}');
	const success = globalThis.fetch;
	let attempts = 0;
	globalThis.fetch = async (...args) => ++attempts === 1 ? new Response(null, { status: 503 }) : success(...args);
	await model.doEvaluate({ state: "x", questions: { retry: { type: "boolean", instructions: "q" } } });
	assert.equal(attempts, 2);
	globalThis.fetch = async () => new Response(null, { status: 503 });
	await assert.rejects(model.doEvaluate({ state: "x", questions: { retry: { type: "boolean", instructions: "q" } }, abortSignal: AbortSignal.timeout(10) }), error => error.name === "AbortError" || error.name === "TimeoutError");
	globalThis.fetch = async () => Response.json({ id: "needed", option_ids: ["true", "false"], probabilities: [0.8, 0.8], input_tokens: 2 });
	await assert.rejects(model.doEvaluate({ state: "x", questions: { needed: { type: "boolean", instructions: "q" } } }), /probability sum/);
	for (const apiUrl of ["file:///tmp/x", "https://user:secret@host/score", "https://host/score?key=x", 42]) {
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "x" } }, fallback: FAST, apiUrl }), /apiUrl/);
	}
});

test("skills are opt-in and work with concrete models without changing routing", async (t) => {
	const skill = skillFixture("opt-in");
	const requests = mockSkillGateway(t);
	const disabled = await harness();
	await setSkills(disabled, [skill]);
	assert.equal(await skillContext(disabled, [user("Use the skill")]), undefined);
	assert.equal(requests.length, 0);
	assert.equal(parseConfig({ options: { [FAST]: { description: "x" } }, fallback: FAST }).skills, false);
	for (const skills of [null, "true", 1, {}]) {
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "x" } }, fallback: FAST, skills }), /skills must be a boolean/);
	}
	configureSkills(t);
	const h = await harness();
	h.ctx.model = h.models[0];
	await setSkills(h, [skill]);
	const messages = [user("Use the skill")];
	const result = await skillContext(h, messages);
	assert.equal(messages.length, 1, "context input is not mutated");
	assert.equal(result.messages.length, 2);
	assert.match(result.messages[1].content, /PRIVATE BODY for opt-in/);
	assert.match(result.messages[1].content, /References are relative to/);
	assert.doesNotMatch(result.messages[1].content, /description: Test skill/);
	const converted = convertToLlm(result.messages);
	assert.deepEqual(routingInput({ messages: converted }), routingInput({ messages }), "injected skill instructions must not become a routing task or leak to Jev");
	assert.equal(h.ctx.model, h.models[0]);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 0);
	assert.equal(requests.length, 1);
	assert.doesNotMatch(JSON.stringify(requests), /PRIVATE BODY|PRIVATE SYSTEM|gateway-test-key/);
	await h.commands.get("jev").handler("", h.ctx);
	assert.match(h.notices.at(-1)[0], /Skills: on/);
});

test("skills are reused on continuations and reload, selected for steering, and scoped to active context", async (t) => {
	configureSkills(t);
	const first = skillFixture("first"), second = skillFixture("second");
	const requests = mockSkillGateway(t);
	const h = await harness();
	await setSkills(h, [first]);
	const initial = [user("First task")];
	const result = await skillContext(h, initial);
	assert.equal(result.messages.filter((m) => m.customType === "jev-skills").length, 1);
	// Stored instructions are reused without rereading the file.
	rmSync(first.filePath);
	assert.deepEqual((await skillContext(h, initial)).messages.map((m) => m.content), result.messages.map((m) => m.content));
	assert.equal((await skillContext(h, result.messages)).messages.length, 2, "an existing injected block is not duplicated");
	const resumed = await harness({ history: h.entries });
	await setSkills(resumed, [first, second]);
	assert.equal((await skillContext(resumed, initial)).messages.length, 2);
	assert.equal(requests.length, 1);
	const next = await skillContext(resumed, [...initial, user("A new steering request", 2)]);
	assert.equal(requests.length, 2);
	assert.deepEqual(Object.values(requests[1].questions).map((q) => q.criteria.true.name), ["second"]);
	assert.equal(next.messages.filter((m) => m.customType === "jev-skills").length, 2);
	assert.equal((await skillContext(resumed, [...initial, user("A new steering request", 2)])).messages.length, 4);
	assert.equal(requests.length, 2);
	// Simulate a branch/compaction where the previous load records and messages are gone.
	resumed.ctx.sessionManager.buildContextEntries = () => [];
	await setSkills(resumed, [second]);
	assert.equal((await skillContext(resumed, [user("Second task after compaction", 3)])).messages.length, 2);
	assert.equal(requests.length, 3);
});

test("skill selection skips explicit blocks, successful reads, aliases, and manual-only skills", async (t) => {
	configureSkills(t);
	const read = skillFixture("read-skill"), explicit = skillFixture("explicit"), hidden = skillFixture("hidden", { disableModelInvocation: true });
	const fresh = skillFixture("fresh");
	const alias = join(agentDir, "alias.md");
	symlinkSync(read.filePath, alias);
	const requests = mockSkillGateway(t);
	const h = await harness();
	await setSkills(h, [read, { ...read, name: "alias", filePath: alias }, explicit, hidden, fresh]);
	const messages = [user(`<skill name="explicit" location="${explicit.filePath}">\nExplicit body\n</skill>`), {
		role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "@read-skill.md" } }], timestamp: 2,
	}, { role: "toolResult", toolName: "read", toolCallId: "read", isError: false, content: [{ type: "text", text: "PRIVATE TOOL CONTENT" }], timestamp: 3 }, user("New request", 4)];
	await skillContext(h, messages);
	assert.deepEqual(Object.values(requests[0].questions).map((q) => q.criteria.true.name), ["fresh"]);
	assert.doesNotMatch(JSON.stringify(requests), /PRIVATE TOOL CONTENT/);
	const system = await harness();
	await setSkills(system, [explicit]);
	system.ctx.getSystemPrompt = () => messages[0].content;
	assert.equal((await skillContext(system, [user("Task")])).messages.length, 1);
	assert.equal(requests.length, 1);
});

test("failed and truncated reads do not mark a skill loaded; weak matches stay unloaded", async (t) => {
	configureSkills(t);
	const skill = skillFixture("read-again");
	const requests = mockSkillGateway(t, { "read-again": 0.79 });
	for (const result of [{ isError: true }, { isError: false, details: { truncation: { truncated: true } } }]) {
		const h = await harness();
		await setSkills(h, [skill]);
		const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: skill.filePath } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: "partial" }], timestamp: 1, ...result }, user("Task", 2)];
		assert.equal((await skillContext(h, messages)).messages.length, 3);
		await skillContext(h, messages);
	}
	assert.equal(requests.length, 2, "no-match decisions also avoid repeat evaluation on tool continuations");
});

test("skill limits and failures leave normal generation available and never expose error bodies", async (t) => {
	configureSkills(t);
	const skills = Array.from({ length: 4 }, (_, i) => skillFixture(`bounded-${i}`));
	const requests = mockSkillGateway(t);
	const h = await harness();
	await setSkills(h, skills);
	await skillContext(h, [user("Task")]);
	assert.equal(h.entries.at(-1).data.loaded.length, 3);
	const oversized = await harness();
	await setSkills(oversized, [{ ...skills[0], description: "x".repeat(30000) }]);
	assert.equal((await skillContext(oversized, [user("Task")])).messages.length, 1);
	assert.equal(requests.length, 1);
	const missing = await harness({ gatewayKey: false });
	await setSkills(missing, skills);
	assert.equal((await skillContext(missing, [user("Task")])).messages.length, 1);
	assert.equal(requests.length, 1);
	mockGateway(t, () => Response.json({ error: "PRIVATE FAILURE BODY" }, { status: 503 }));
	const failed = await harness();
	await setSkills(failed, skills);
	assert.equal((await skillContext(failed, [user("Task")])).messages.length, 1);
	assert.doesNotMatch(JSON.stringify(failed.notices) + JSON.stringify(failed.entries), /PRIVATE FAILURE BODY/);
});

test("skill file failures skip only that skill and cancellation saves no decision", async (t) => {
	configureSkills(t);
	const missing = skillFixture("missing-body"), huge = skillFixture("huge-body"), good = skillFixture("good-body");
	rmSync(missing.filePath);
	writeFileSync(huge.filePath, "x".repeat(50001));
	mockSkillGateway(t);
	const h = await harness();
	await setSkills(h, [missing, huge, good]);
	const result = await skillContext(h, [user("Task")]);
	assert.match(result.messages.at(-1).content, /PRIVATE BODY for good-body/);
	assert.deepEqual(h.entries.at(-1).data.loaded.map((s) => s.name), ["good-body"]);
	assert.equal(h.notices.filter(([, level]) => level === "warning").length, 2);
	const started = Promise.withResolvers();
	mockGateway(t, (options) => new Promise((_, reject) => {
		started.resolve();
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	}));
	const cancelled = await harness();
	await setSkills(cancelled, [good]);
	const stop = new AbortController();
	cancelled.ctx.signal = stop.signal;
	const pending = skillContext(cancelled, [user("Task")]);
	await started.promise;
	stop.abort();
	assert.equal(await pending, undefined);
	assert.equal(cancelled.entries.length, 0);
});

test("declares the AI SDK's required runtime peers for Pi's peer-disabled npm installs", () => {
	const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	const sdk = JSON.parse(readFileSync(new URL(import.meta.resolve("ai/package.json")), "utf8"));
	for (const peer of Object.keys(sdk.peerDependencies ?? {})) {
		if (sdk.peerDependenciesMeta?.[peer]?.optional) continue;
		assert.ok(manifest.dependencies?.[peer], `Pi skips peer installation; ${peer} must be a runtime dependency.`);
	}
});

test("pins the session, forwards tools/auth/hooks/usage, and preserves actual model identity", async (t) => {
	const requests = mockGateway(t);
	const h = await harness();
	assert.equal(h.ctx.model.contextWindow, 272000);
	assert.deepEqual(h.ctx.model.input, ["text", "image"]);
	const input = context();
	input.messages.unshift({ role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }], timestamp: 0 });
	const events = [];
	for await (const event of h.stream(input, { onPayload: (payload, model) => ({ ...payload, actualProvider: model.provider }), maxTokens: 999999 })) events.push(event);
	assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_end", "done"]);
	const first = h.calls[0];
	assert.equal(first.model.id, "gpt-5.6-luna");
	assert.equal(first.model.baseUrl, "https://backend.example.invalid");
	assert.equal(first.options.apiKey, "codex-test-key");
	assert.deepEqual(first.options.headers, { "x-backend": "yes" });
	assert.deepEqual(first.options.env, { BACKEND: "yes" });
	assert.equal(first.options.reasoning, "max");
	assert.equal(first.options.maxTokens, 128000);
	assert.equal(first.context, input);
	assert.equal(first.payload.actualProvider, "openai-codex");
	assert.equal(events.at(-1).message, first.message);
	assert.equal(events.at(-1).message.usage, usage);
	assert.deepEqual(requests[0].state.messages, [{ role: "user", text: "Fix a typo" }]);
	assert.deepEqual(Object.values(requests[0].questions.route.criteria).map(({ model, thinking }) => [model, thinking]), [[FAST, "max"], [DEEP, "xhigh"]]);
	assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|codex-test-key|router-secret/);
	assert.equal(h.entries[0].data.inputTokens, 1000);
	assert.equal(h.entries[0].data.estimatedCost, 0.000042);

	await h.stream({ ...input, messages: [...input.messages, first.message] }).result();
	assert.equal(requests.length, 1, "tool continuation must keep its route");
	await h.stream(context("Fix a typo", 3)).result();
	assert.equal(requests.length, 2, "a new user message may trigger an advisory check");
	assert.equal(h.calls.at(-1).model.id, "gpt-5.6-luna");
	await h.stream(context("Summarize", 4), { sessionId: "compaction" }).result();
	assert.equal(requests.length, 2, "auxiliary calls must not expose synthetic prompts to Jev");
	assert.equal(h.calls.at(-1).model.id, "gpt-5.6-luna", "auxiliary calls use the session pin");
	await h.stream(context("Fix a typo", 3)).result();
	assert.equal(requests.length, 2, "compaction must not replace the main route");
});

test("active router limits follow the backend without rerouting continuations or auxiliary calls", async (t) => {
	let selected = DEEP;
	const requests = mockGateway(t, () => selected);
	const h = await harness();
	Object.assign(h.models[0], { contextWindow: 128000, maxTokens: 8192, input: ["text"] });
	Object.assign(h.models[1], { contextWindow: 1000000, maxTokens: 64000 });
	await h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.ctx.model.contextWindow, 128000, "startup limits remain conservative until routing");
	const initialRouter = h.ctx.model;

	let windowAtGeneration;
	const large = await h.stream(context(), { onPayload: (payload) => {
		windowAtGeneration = h.ctx.model.contextWindow;
		return payload;
	} }).result();
	assert.equal(large.model, "gpt-6-astra");
	assert.equal(windowAtGeneration, 1000000, "limits must update before generation");
	assert.equal(h.ctx.model.maxTokens, 64000);
	assert.equal(h.ctx.model.provider, "auto");
	assert.equal(h.ctx.model.id, "jev");
	assert.equal(h.ctx.modelRegistry.find("auto", "jev").contextWindow, 1000000);
	// Scoped model cycling can restore an older model object than the registry holds.
	h.ctx.model = initialRouter;
	await h.stream().result();
	assert.equal(h.ctx.model.contextWindow, 1000000);
	assert.equal(requests.length, 1, "refreshing limits must not clear the pinned route");

	selected = FAST;
	const next = context("A smaller task", 3);
	assert.equal((await h.stream(next).result()).model, "gpt-6-astra");
	assert.equal(h.ctx.model.contextWindow, 1000000, "advice must not change the active limits");
	assert.equal(h.ctx.model.maxTokens, 64000);
	assert.deepEqual(h.ctx.model.input, ["text", "image"]);
	assert.equal((await h.stream(context("Summarize"), { sessionId: "compaction" }).result()).model, "gpt-6-astra");
	assert.equal(h.ctx.model.contextWindow, 1000000);
	Object.assign(h.models[1], { contextWindow: 256000, maxTokens: 16384 });
	assert.equal((await h.stream(next).result()).model, "gpt-6-astra");
	assert.equal(h.ctx.model.contextWindow, 256000, "refresh changed limits on the pinned backend");
	assert.equal(h.ctx.model.maxTokens, 16384);
	await h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
	assert.equal(h.ctx.model.contextWindow, 256000, "reload restores the pinned backend's limits before generation");
	assert.equal(requests.length, 2);
});

test("Jev chooses automatic effort once, and pins it across messages and auxiliary calls", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options: { [FAST]: { description: "Routine work", thinking: "auto" } }, fallback: FAST } }));
	let thinking = "low";
	const requests = mockGateway(t, () => ({ target: FAST, thinking }));
	const h = await harness({ refs: [FAST] });
	await h.stream().result();
	assert.equal(requests.length, 1, "one model still needs effort selection");
	assert.deepEqual(Object.values(requests[0].questions.route.criteria).map((profile) => profile.thinking), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(h.calls[0].options.reasoning, "low");
	assert.equal(h.entries[0].data.thinking, "low");
	await h.commands.get("jev").handler("", h.ctx);
	assert.match(h.notices.at(-1)[0], /thinking low/);

	await h.stream(context("Summarize"), { sessionId: "compaction" }).result();
	assert.equal(h.calls.at(-1).options.reasoning, "low", "auxiliary calls use the pinned effort");
	thinking = "high";
	await h.stream().result();
	assert.equal(h.calls.at(-1).options.reasoning, "low");
	assert.equal(requests.length, 1);
	await h.stream(context("Harder task", 3)).result();
	assert.equal(h.calls.at(-1).options.reasoning, "low", "a new message must not change effort");
	assert.equal(requests.length, 1, "no different model exists to recommend");
	h.models[0].thinkingLevelMap.low = null;
	const callsBefore = h.calls.length;
	assert.match((await h.stream(context("Another task", 4)).result()).errorMessage, /pinned Jev thinking level is no longer supported/);
	assert.equal(h.calls.length, callsBefore, "unsupported pins must not silently change");
	const fork = await harness({ refs: [FAST], history: h.entries, sessionId: "fork" });
	await fork.stream(context("Harder task", 5)).result();
	assert.equal(fork.calls[0].options.reasoning, "high");
	assert.equal(requests.length, 2);
});

test("adaptive Astra effort changes on tool continuations, preserving the initial effort and update history", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { minThinking: "medium", options: {
		[DEEP]: { description: "Deep work", thinking: "auto", adaptiveThinking: true },
	}, fallback: DEEP } }));
	let thinking = "medium";
	const requests = mockGateway(t, () => ({ target: DEEP, thinking }));
	const h = await harness({ refs: [DEEP], responsesPayload: true });
	const input = context("Fix the failure");
	await h.stream(input).result();
	const initial = h.calls[0].payload;
	assert.equal(requests.length, 1, "initial routing already chooses effort");
	input.messages.push(h.calls[0].message, { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: true, content: [{ type: "text", text: "Unresolved failure" }], timestamp: 3 });
	thinking = "high";
	await h.stream(input).result();
	const high = h.calls[1].payload;
	assert.equal(high.reasoning.effort, "medium");
	assert.deepEqual(high.input.slice(0, initial.input.length), initial.input);
	assert.deepEqual(high.input.at(-1), { type: "configuration_update", reasoning: { effort: "high" } });
	assert.deepEqual(Object.keys(requests[1].questions.effort.criteria), ["medium", "high", "xhigh", "max"]);
	assert.equal(requests[1].state.recent.at(-1).isError, true);
	assert.equal(requests[1].state.recent.at(-1).text, "Unresolved failure");
	const historicalAuxiliary = await harness({ refs: [DEEP], responsesPayload: true, history: h.entries });
	await historicalAuxiliary.stream(context("Fix the failure"), { sessionId: "compaction" }).result();
	assert.equal(historicalAuxiliary.calls[0].payload.input.at(-1).reasoning.effort, "high", "auxiliary calls use current effort, even when their context matches an earlier decision");
	assert.equal(historicalAuxiliary.entries.length, h.entries.length);
	assert.equal(requests.length, 2);
	input.messages.push(h.calls[1].message, { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "Fixed, all checks pass" }], timestamp: 4 });
	thinking = "medium";
	await h.stream(input).result();
	const medium = h.calls[2].payload;
	assert.equal(medium.reasoning.effort, "medium");
	assert.deepEqual(medium.input.slice(0, high.input.length), high.input, "the whole earlier payload prefix is unchanged");
	assert.deepEqual(medium.input.at(-1), { type: "configuration_update", reasoning: { effort: "medium" } });
	assert.equal(requests.length, 3);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	const resumed = await harness({ refs: [DEEP], responsesPayload: true, history: h.entries });
	await resumed.stream(input).result();
	assert.deepEqual(resumed.calls[0].payload, medium);
	assert.equal(requests.length, 3, "retry/reload does not reevaluate the same step");
	const before = resumed.entries.length;
	await resumed.stream(input, { sessionId: "compaction" }).result();
	assert.equal(requests.length, 3, "auxiliary calls do not evaluate effort");
	assert.equal(resumed.entries.length, before, "auxiliary calls do not record changes");
	await resumed.commands.get("jev").handler("", resumed.ctx);
	assert.match(resumed.notices.at(-1)[0], /thinking medium \(initial medium\)/);
	assert.match(resumed.notices.at(-1)[0], /adaptive/);
});

test("Astra updates rebase after compaction, follow branch state, and remain replayed when adaptation is disabled", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const config = { options: { [DEEP]: { description: "Deep", thinking: "auto", adaptiveThinking: true } }, fallback: DEEP, monitor: false };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const requests = mockGateway(t, () => "high");
	const history = [{ name: "jev-pin", data: { target: DEEP, thinking: "medium", sessionId: "main" } }];
	const h = await harness({ refs: [DEEP], responsesPayload: true, history });
	await h.stream(context("Failed again")).result();
	assert.equal(h.calls[0].payload.input.at(-1).reasoning.effort, "high");
	config.options[DEEP].adaptiveThinking = false;
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const resumed = await harness({ refs: [DEEP], responsesPayload: true, history: h.entries });
	await resumed.stream(context("Compacted history", 7)).result();
	assert.equal(resumed.calls[0].payload.reasoning.effort, "medium");
	assert.equal(resumed.calls[0].payload.input.filter((item) => item.type === "configuration_update").length, 1);
	assert.equal(resumed.calls[0].payload.input.at(-1).reasoning.effort, "high");
	assert.equal(requests.length, 1);
	let status;
	resumed.ctx.ui.setStatus = (_key, value) => { status = value; };
	await resumed.handlers.get("session_tree")({}, resumed.ctx);
	assert.match(status, /high/);
	resumed.ctx.sessionManager.getBranch = () => [];
	await resumed.handlers.get("session_tree")({}, resumed.ctx);
	assert.match(status, /medium/, "branch navigation refreshes effort before the next request");
	await resumed.stream(context("Earlier branch", 8)).result();
	assert.equal(resumed.calls[1].options.reasoning, "medium");
	assert.equal(resumed.calls[1].payload, undefined, "an abandoned branch's effort must not leak into requests");
});

test("adaptive effort failure and invalid choices retain current effort without sending private reasoning or tool arguments", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { minThinking: "medium", options: { [DEEP]: { description: "Deep", thinking: "auto", adaptiveThinking: true } }, fallback: DEEP } }));
	const requests = mockGateway(t, () => "low");
	const history = [{ name: "jev-pin", data: { target: DEEP, thinking: "high", sessionId: "main" } }];
	const h = await harness({ refs: [DEEP], responsesPayload: true, history });
	const input = context();
	input.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE REASONING" }, { type: "toolCall", id: "x", name: "read", arguments: { path: "PRIVATE ARGUMENT" } }], timestamp: 2 });
	await h.stream(input).result();
	assert.equal(h.calls[0].payload.reasoning.effort, "high");
	assert.equal(h.calls[0].payload.input.filter((item) => item.type === "configuration_update").length, 0);
	assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE/);
	assert.match(h.notices.at(-1)[0], /Keeping the current effort/);
	const missing = await harness({ refs: [DEEP], responsesPayload: true, history, gatewayKey: false });
	await missing.stream().result();
	assert.equal(missing.calls[0].payload.reasoning.effort, "high");
	const controller = new AbortController();
	controller.abort();
	await h.stream(context("Cancelled", 3), { signal: controller.signal }).result();
	assert.equal(h.calls.length, 1);
});

test("adaptive effort retries a busy gateway before keeping the current effort", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options: { [DEEP]: { description: "Deep", thinking: "auto", adaptiveThinking: true } }, fallback: DEEP } }));
	let attempts = 0;
	const requests = mockGateway(t, () => ++attempts === 1 ? Response.json({ error: "GPU busy" }, { status: 503 }) : "high");
	const history = [{ name: "jev-pin", data: { target: DEEP, thinking: "medium", sessionId: "main" } }];
	const h = await harness({ refs: [DEEP], responsesPayload: true, history });
	await h.stream().result();
	assert.equal(requests.length, 2);
	assert.equal(h.calls[0].payload.input.at(-1).reasoning.effort, "high");
	assert.ok(!h.notices.some(([text]) => text.includes("effort check failed")));
});

test("adaptive effort cancellation saves no decision and timeout keeps the existing effort", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { timeoutMs: 20, options: { [DEEP]: { description: "Deep", thinking: "auto", adaptiveThinking: true } }, fallback: DEEP } }));
	const started = Promise.withResolvers();
	mockGateway(t, (options) => new Promise((_resolve, reject) => {
		started.resolve();
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	}));
	const history = [{ name: "jev-pin", data: { target: DEEP, thinking: "medium", sessionId: "main" } }];
	const h = await harness({ refs: [DEEP], responsesPayload: true, history });
	const controller = new AbortController();
	const result = h.stream(context(), { signal: controller.signal }).result();
	await started.promise;
	controller.abort();
	assert.equal((await result).stopReason, "aborted");
	assert.equal(h.entries.length, 1);
	assert.equal(h.calls.length, 0);
	const keepAlive = setInterval(() => {}, 50);
	try {
		await h.stream().result();
		assert.equal(h.calls[0].payload.reasoning.effort, "medium");
		assert.match(h.notices.at(-1)[0], /Keeping the current effort/);
	} finally { clearInterval(keepAlive); }
});

test("effort payload preserves headers/settings, rejects incompatible modes, and maps provider effort names", () => {
	const body = { input: [{ role: "user", content: "Task" }], reasoning: { effort: "high", summary: "auto" }, prompt_cache_key: "session", tools: [] };
	const high = effortPayload(body, [], "high", "medium");
	assert.equal(high.payload.reasoning.effort, "medium");
	assert.equal(high.payload.reasoning.summary, "auto");
	assert.equal(high.payload.prompt_cache_key, "session");
	assert.equal(body.input.length, 1, "do not mutate the original payload");
	const entries = [{ thinking: "high", update: high.update }];
	const down = effortPayload(body, entries, "medium", "medium");
	assert.equal(down.payload.input.filter((item) => item.type === "configuration_update").length, 1, "same-boundary changes cannot produce adjacent updates");
	assert.equal(down.payload.input.at(-1).reasoning.effort, "medium");
	assert.equal(effortPayload(body, [], "minimal", "medium", { minimal: "low" }).payload.input.at(-1).reasoning.effort, "low");
	for (const extra of [{ truncation: "auto" }, { context_management: [] }, { input: [{ type: "configuration_update" }] }]) {
		assert.throws(() => effortPayload({ ...body, ...extra }, [], "high", "medium"), /Astra/);
	}
	assert.throws(() => effortPayload({}, [], "high", "medium"), /Responses/);
	for (const adaptiveThinking of [null, "true", 1]) assert.throws(() => parseConfig({ options: { [DEEP]: { description: "Deep", thinking: "auto", adaptiveThinking } }, fallback: DEEP }), /adaptiveThinking/);
	for (const [target, thinking] of [[FAST, "auto"], [DEEP, "high"], [DEEP, undefined]]) {
		assert.throws(() => parseConfig({ options: { [target]: { description: "Task", thinking, adaptiveThinking: true } }, fallback: target }), /adaptiveThinking/);
	}
});

test("structured three-model criteria survive routing and monitoring", async (t) => {
	const middle = "openai-codex/gpt-5.6-sol";
	const rubric = { role: "Executor", use_when: ["Known approach"], not_for: ["Architecture"], boundary: "Execute rather than advise" };
	const config = { options: Object.fromEntries([FAST, middle, DEEP].map(ref => [ref, { description: rubric, thinking: "auto" }])), fallback: DEEP };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	t.after(() => rmSync(settingsPath, { force: true }));
	const requests = mockGateway(t, () => ({ target: middle, thinking: "medium" }));
	const h = await harness({ refs: [FAST, middle, DEEP] });
	await h.stream().result();
	assert.equal(h.calls[0].model.id, "gpt-5.6-sol");
	assert.deepEqual(new Set(Object.values(requests[0].questions.route.criteria).map(p => p.model)), new Set([FAST, middle, DEEP]));
	await h.stream(context("Next task", 3)).result();
	for (const request of requests) {
		for (const profile of Object.values(request.questions.route.criteria)) assert.deepEqual(profile.task, rubric);
		assert.match(request.questions.route.instructions, /High effort does not expand/);
	}
	for (const description of [{}, { ...rubric, use_when: [] }, { ...rubric, not_for: [1] }, { ...rubric, boundary: "" }]) {
		assert.throws(() => parseConfig({ ...config, options: { [DEEP]: { description } } }), /Invalid Jev route/);
	}
});

test("global and model thinking floors constrain routing, monitoring, and fallback without rewriting pins", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const config = { minThinking: "medium", options: {
		[FAST]: { description: "Routine", thinking: "auto", minThinking: "high" },
		[DEEP]: { description: "Deep", thinking: "auto" },
	}, fallback: DEEP };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	let desired = { target: FAST, thinking: "high" };
	const requests = mockGateway(t, () => desired);
	const h = await harness();
	await h.stream().result();
	assert.equal(h.calls[0].options.reasoning, "high");
	assert.equal(requests.length, 1, "model and effort still use one evaluation");
	assert.match(requests[0].questions.route.instructions, /model by task fit.*first/);
	assert.match(requests[0].questions.route.instructions, /Effort levels are model-relative/);
	assert.match(requests[0].questions.route.instructions, /configured effort floor may exceed/);
	assert.deepEqual(Object.values(requests[0].questions.route.criteria).map(({ model, thinking }) => [model, thinking]),
		[[FAST, "high"], [FAST, "xhigh"], [FAST, "max"], [DEEP, "medium"], [DEEP, "high"], [DEEP, "xhigh"], [DEEP, "max"]]);
	await h.commands.get("jev").handler("", h.ctx);
	assert.match(h.notices.at(-1)[0], /Global minimum thinking: medium/);
	assert.match(h.notices.at(-1)[0], /model minimum high/);
	desired = { target: DEEP, thinking: "medium" };
	await h.stream(context("Hard task", 3)).result();
	assert.equal(h.calls.at(-1).options.reasoning, "high");
	assert.equal(h.entries.find((entry) => entry.name === "jev-suggestion").data.thinking, "medium");
	assert.match(requests[1].questions.route.instructions, /task fit first/);
	assert.match(requests[1].questions.route.instructions, /not a reason to fork/);
	const fallback = await harness({ gatewayKey: false });
	await fallback.stream().result();
	assert.equal(fallback.calls[0].options.reasoning, "max");
	const auxiliary = await harness();
	await auxiliary.stream(context(), { sessionId: "compaction" }).result();
	assert.equal(auxiliary.calls[0].options.reasoning, "max");
	config.minThinking = "max";
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const resumed = await harness({ history: h.entries });
	await resumed.stream(context("Continue", 4)).result();
	assert.equal(resumed.calls[0].options.reasoning, "high", "new floors do not change saved pins");
});

test("only Codex Astra can override the global floor for initial routing and adaptive effort", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { minThinking: "medium", options: {
		[FAST]: { description: "Routine", thinking: "auto", minThinking: "low" },
		[DEEP]: { description: "Deep", thinking: "auto", minThinking: "low", adaptiveThinking: true },
	}, fallback: DEEP } }));
	let thinking = "high";
	const requests = mockGateway(t, () => ({ target: DEEP, thinking }));
	const h = await harness({ responsesPayload: true });
	const input = context();
	await h.stream(input).result();
	const profiles = Object.values(requests[0].questions.route.criteria);
	assert.deepEqual(profiles.filter((profile) => profile.model === DEEP).map((profile) => profile.thinking), ["low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(profiles.filter((profile) => profile.model === FAST).map((profile) => profile.thinking), ["medium", "high", "xhigh", "max"]);
	input.messages.push(h.calls[0].message, { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "Ready for routine follow-through" }], timestamp: 3 });
	thinking = "low";
	await h.stream(input).result();
	assert.deepEqual(Object.keys(requests[1].questions.effort.criteria), ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(h.calls[1].payload.reasoning.effort, "high", "the initial request effort stays fixed for caching");
	assert.equal(h.calls[1].payload.input.at(-1).reasoning.effort, "low");
	const initialLow = await harness({ responsesPayload: true });
	await initialLow.stream().result();
	assert.equal(initialLow.calls[0].options.reasoning, "low");
});

test("thinking floors raise fixed and inherited effort, respect capability gaps and custom choices, and never clamp below the floor", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const route = { description: "Routine", minThinking: "low" };
	const config = { minThinking: "medium", options: { [FAST]: route }, fallback: FAST };
	for (const thinking of [undefined, "low"]) {
		route.thinking = thinking;
		writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
		const h = await harness({ refs: [FAST] });
		h.models[0].thinkingLevelMap.medium = null;
		await h.stream(context(), { reasoning: "off" }).result();
		assert.equal(h.calls[0].options.reasoning, "high", "a lower model floor cannot weaken the global floor");
	}
	route.thinking = { low: "Simple", high: "Complex" };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const custom = await harness({ refs: [FAST] });
	await custom.stream().result();
	assert.equal(custom.calls[0].options.reasoning, "high");
	config.minThinking = "max";
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const excluded = await harness({ refs: [FAST] });
	assert.match((await excluded.stream().result()).errorMessage, /configured thinking choices and minimums/);
	assert.equal(excluded.calls.length, 0, "custom choices must not be expanded to satisfy the floor");
	route.thinking = "auto";
	config.options[DEEP] = { description: "Deep", thinking: "auto" };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const unsupported = await harness({ gatewayKey: false });
	unsupported.models[0].reasoning = false;
	unsupported.models[1].thinkingLevelMap.max = null;
	assert.match((await unsupported.stream().result()).errorMessage, /configured thinking choices and minimums/);
	assert.equal(unsupported.calls.length, 0);
	config.minThinking = "high";
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const badFallback = await harness({ gatewayKey: false });
	badFallback.models[0].reasoning = false;
	assert.match((await badFallback.stream().result()).errorMessage, /fallback .* thinking policy/);
	assert.equal(badFallback.calls.length, 0);
});

test("thinking floors accept only named levels", () => {
	for (const minThinking of [null, "auto", "turbo", 3, {}, []]) {
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "Routine" } }, fallback: FAST, minThinking }), /minThinking/);
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "Routine", minThinking } }, fallback: FAST }), /minThinking/);
	}
	assert.equal(parseConfig({ options: { [FAST]: { description: "Routine", minThinking: "high" } }, fallback: FAST, minThinking: "medium" }).options[FAST].minThinking, "high");
});

test("custom effort choices filter unsupported levels while fixed levels override Pi thinking", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: {
		options: {
			[FAST]: { description: "Routine work", thinking: { low: "Small patches", high: "Risky patches", xhigh: "Major investigation" } },
			[DEEP]: { description: "Deep work", thinking: "max" },
		}, fallback: DEEP,
	} }));
	let target = FAST;
	const requests = mockGateway(t, () => target);
	const h = await harness();
	h.models[0].thinkingLevelMap = { low: null, xhigh: null };
	await h.stream().result();
	const profiles = Object.values(requests[0].questions.route.criteria);
	assert.deepEqual(profiles.map(({ model, thinking }) => [model, thinking]), [[FAST, "high"], [DEEP, "max"]]);
	assert.equal(profiles[0].effort, "Risky patches");
	assert.equal(h.calls[0].options.reasoning, "high");
	target = DEEP;
	const fixed = await harness();
	await fixed.stream(context("Next task", 3), { reasoning: "low" }).result();
	assert.equal(fixed.calls[0].options.reasoning, "max", "a fixed route policy must win over Pi's selected level");
	const clamped = await harness();
	clamped.models[1].thinkingLevelMap.max = null;
	await clamped.stream(context("Another task", 4)).result();
	assert.equal(clamped.calls[0].options.reasoning, "xhigh", "fixed effort is clamped before the initial pin");
});

test("effort fallback stays within custom choices and non-reasoning models need no evaluator", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const options = { [FAST]: { description: "Routine work", thinking: { high: "Complex", low: "Simple" } } };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options, fallback: FAST } }));
	const requests = mockGateway(t, () => ({ target: FAST, thinking: "max" }));
	const h = await harness({ refs: [FAST] });
	await h.stream().result();
	assert.equal(h.entries[0].data.source, "fallback", "unoffered effort must be rejected");
	assert.equal(h.calls[0].options.reasoning, "high", "fallback uses effort order, not config insertion order");
	const missing = await harness({ refs: [FAST], gatewayKey: false });
	await missing.stream().result();
	assert.equal(missing.calls[0].options.reasoning, "high");
	assert.equal(requests.length, 1);

	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options: { [FAST]: { description: "No reasoning", thinking: "auto" } }, fallback: FAST } }));
	const noReasoning = await harness({ refs: [FAST] });
	noReasoning.models[0].reasoning = false;
	await noReasoning.stream().result();
	assert.equal(noReasoning.calls[0].options.reasoning, undefined);
	assert.equal(noReasoning.entries[0].data.thinking, "off");
	assert.equal(requests.length, 1);
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options, fallback: FAST } }));
	const unsupported = await harness({ refs: [FAST] });
	unsupported.models[0].reasoning = false;
	assert.match((await unsupported.stream().result()).errorMessage, /No Jev routes support the configured thinking/);
	assert.equal(unsupported.calls.length, 0);
});

test("fork suggestions never switch the session pin and survive reload without repeated notices", async (t) => {
	let desired = FAST;
	const requests = mockGateway(t, () => desired);
	const h = await harness();
	await h.stream().result();
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	desired = DEEP;
	const followup = context("Investigate a difficult architecture problem", 3);
	assert.equal((await h.stream(followup).result()).model, "gpt-5.6-luna");
	assert.equal(h.calls.at(-1).options.reasoning, "max");
	assert.equal(h.calls.at(-1).context, followup);
	assert.equal(followup.messages.length, 1, "suggestions must not be injected into model context");
	assert.match(requests[1].questions.route.instructions, /Prefer keeping it/);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-suggestion").length, 1);
	assert.match(h.notices.at(-1)[0], /\/fork.*\/model openai-codex\/gpt-6-astra.*\/thinking xhigh/);
	assert.equal(h.entries.find((entry) => entry.name === "jev-monitor").data.inputTokens, 1000);
	await h.stream(followup).result();
	await h.stream(context("Continue the investigation", 4)).result();
	assert.equal(requests.length, 2, "no more evaluations once every alternative has been suggested");
	assert.equal(h.notices.length, 1);

	const resumed = await harness({ history: h.entries });
	resumed.ctx.sessionManager.getBranch = () => [];
	await resumed.handlers.get("session_start")({ reason: "reload" }, resumed.ctx);
	assert.equal((await resumed.stream(context("Continue", 5)).result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 2, "pins and suggestion suppression survive reload/resume and tree branches");
	await resumed.commands.get("jev").handler("", resumed.ctx);
	assert.match(resumed.notices.at(-1)[0], /Pinned: openai-codex\/gpt-5.6-luna, thinking max/);
	assert.match(resumed.notices.at(-1)[0], /Fork suggestion: openai-codex\/gpt-6-astra/);
	resumed.ctx.model = resumed.models[1];
	await resumed.handlers.get("model_select")({ model: resumed.ctx.model }, resumed.ctx);
	resumed.ctx.model = resumed.ctx.modelRegistry.find("auto", "jev");
	await resumed.handlers.get("model_select")({ model: resumed.ctx.model }, resumed.ctx);
	assert.equal((await resumed.stream(context("Return to auto", 6)).result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 2);

	const fork = await harness({ history: h.entries, sessionId: "new-fork-id" });
	assert.equal((await fork.stream(context("Investigate", 7)).result()).model, "gpt-6-astra");
	assert.equal(requests.length, 3, "a fork must not inherit its parent's pin");
	assert.equal(fork.entries.filter((entry) => entry.name === "jev-pin" && entry.data.sessionId === "new-fork-id").length, 1);
});

test("monitor can be disabled and saved pins never silently change after config or availability changes", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const config = { options: { [FAST]: { description: "Routine", thinking: "low" }, [DEEP]: { description: "Deep", thinking: "high" } }, fallback: DEEP, monitor: false };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	let desired = FAST;
	const requests = mockGateway(t, () => desired);
	const h = await harness();
	await h.stream().result();
	desired = DEEP;
	assert.equal((await h.stream(context("Different task", 3)).result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 1);
	config.options[FAST].thinking = "high";
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const resumed = await harness({ history: h.entries });
	await resumed.stream(context("Continue", 4)).result();
	assert.equal(resumed.calls[0].options.reasoning, "low", "settings edits must not rewrite an existing pin");
	delete config.options[FAST];
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const removed = await harness({ history: h.entries });
	assert.match((await removed.stream().result()).errorMessage, /pinned Jev route is unavailable/);
	assert.equal(removed.calls.length, 0);
	assert.equal(requests.length, 1);
	await assert.rejects(harness({ history: [{ name: "jev-pin", data: { sessionId: "main", target: FAST, thinking: "turbo" } }] }), /Invalid saved jev-pin/);
});

test("failed or cancelled monitoring never suggests a fallback or drops the existing pin", async (t) => {
	let mode = "initial";
	const started = Promise.withResolvers();
	const requests = mockGateway(t, (options) => {
		if (mode === "failed") return Response.json({ error: "PRIVATE MONITOR BODY" }, { status: 503 });
		if (mode === "hanging") return new Promise((_, reject) => {
			started.resolve();
			options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
		});
		return mode === "initial" ? FAST : DEEP;
	});
	const h = await harness();
	await h.stream().result();
	mode = "failed";
	assert.equal((await h.stream(context("Harder task", 3)).result()).model, "gpt-5.6-luna");
	assert.equal(h.entries.filter((entry) => entry.name === "jev-suggestion").length, 0);
	assert.doesNotMatch(JSON.stringify(h.entries), /PRIVATE MONITOR BODY/);
	const resumed = await harness({ history: h.entries });
	await resumed.stream(context("Harder task", 3)).result();
	assert.equal(requests.length, 2, "reload must not repeat a completed check for the same message");
	mode = "hanging";
	const controller = new AbortController();
	const pending = h.stream(context("Another task", 4), { signal: controller.signal }).result();
	await started.promise;
	controller.abort();
	assert.equal((await pending).stopReason, "aborted");
	assert.equal(h.calls.length, 2);
	mode = "recommend";
	assert.equal((await h.stream(context("Another task", 4)).result()).model, "gpt-5.6-luna");
	assert.equal(h.calls.at(-1).options.reasoning, "max");
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-suggestion").length, 1);
});

test("auxiliary requests before the first user route do not create a session pin", async (t) => {
	const requests = mockGateway(t);
	const h = await harness();
	assert.equal((await h.stream(context("Synthetic summary"), { sessionId: "compaction" }).result()).model, "gpt-6-astra");
	assert.equal(requests.length, 0);
	assert.equal(h.entries.length, 0);
	assert.equal((await h.stream().result()).model, "gpt-5.6-luna");
	assert.equal((await h.stream(context("Synthetic summary"), { sessionId: "compaction" }).result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 1);
});

test("only allowlisted available models are offered; Gateway failures never invoke Gateway generation", async (t) => {
	const requests = mockGateway(t, () => Response.json({ error: "PRIVATE SERVER BODY" }, { status: 503 }));
	const h = await harness();
	const result = await h.stream().result();
	assert.equal(result.model, "gpt-6-astra");
	assert.equal(requests.length, 1, "no SDK retry delays");
	assert.equal(h.calls[0].options.reasoning, "xhigh");
	assert.equal(h.entries[0].data.source, "fallback");
	assert.doesNotMatch(JSON.stringify(h.notices), /PRIVATE SERVER BODY/);
	await h.stream().result();
	assert.equal(requests.length, 1, "fallback is also pinned");

	const single = await harness({ refs: [FAST] });
	await single.stream().result();
	assert.equal(single.calls[0].model.id, "gpt-5.6-luna");
	assert.equal(requests.length, 1, "one candidate needs no evaluator");
	const none = await harness({ refs: [] });
	assert.equal((await none.stream().result()).stopReason, "error");
	assert.equal(none.calls.length, 0);
});

test("missing key, invalid choice, and image-only prompts use the configured fallback", async (t) => {
	const requests = mockGateway(t, () => "openai/unapproved-paid-model");
	const invalid = await harness();
	assert.equal((await invalid.stream().result()).model, "gpt-6-astra");
	const missing = await harness({ gatewayKey: false });
	assert.equal((await missing.stream().result()).model, "gpt-6-astra");
	assert.equal(requests.length, 1);
	assert.equal((await missing.stream(context("x".repeat(16001), 2)).result()).model, "gpt-6-astra");
	const imageInput = context();
	imageInput.messages = [{ role: "user", content: [{ type: "image", data: "PRIVATE BASE64", mimeType: "image/png" }], timestamp: 3 }];
	assert.equal((await missing.stream(imageInput).result()).model, "gpt-6-astra");
	assert.equal(requests.length, 1);
});

test("routes a whole long task, dropping older history instead of truncating the task", async (t) => {
	const requests = mockGateway(t);
	const h = await harness();
	const text = "Follow all requirements:\n" + "x".repeat(20_000) + "\nIMPORTANT FINAL CONSTRAINT";
	const input = context(text);
	input.messages.unshift(user("Older conversation ".repeat(2000), 0));
	assert.equal((await h.stream(input).result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].state.messages, [{ role: "user", text }]);
	assert.ok(Buffer.byteLength(JSON.stringify({ state: requests[0].state, questions: requests[0].questions })) <= 28_000);
	assert.equal(h.calls[0].context, input, "the generation provider still receives the original history");
	assert.equal(input.messages.length, 2);
	assert.equal(h.entries[0].data.source, "jev");
});

test("chunks complete Unicode task text with bounded parallelism, then pins only the combined decision", async (t) => {
	const firstPair = Promise.withResolvers();
	let active = 0, peak = 0, started = 0;
	const requests = mockGateway(t, async (_options, body) => {
		assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 28_000, "the entire serialized request must fit");
		if (body.state.stage === "combined") {
			assert.equal(active, 0, "combining waits for every chunk");
			assert.ok(body.state.assessments.some((item) => item.choice === "1"));
			assert.ok(body.state.assessments.filter((item) => item.choice === "0").length > body.state.assessments.filter((item) => item.choice === "1").length);
			assert.ok(body.state.assessments.every((item) => item.probabilities));
			assert.match(body.questions.route.instructions, /Do not average scores or take a majority vote/);
			return DEEP;
		}
		assert.equal(body.state.stage, "chunk");
		active++;
		peak = Math.max(peak, active);
		if (++started === 2) firstPair.resolve();
		await firstPair.promise;
		active--;
		const choice = body.state.chunk.text.includes("SECURITY_REQUIREMENT") ? "1" : "0";
		return Response.json({ answers: { route: { type: "choice", choice, probabilities: { "0": choice === "0" ? 1 : 0, "1": choice === "1" ? 1 : 0 } } }, usage: { inputTokens: 1000, outputTokens: 0 } });
	});
	const pattern = "\u0000α😀\\\"\n";
	const text = "Implement the requirements throughout this document.\n" + pattern.repeat(4000) + "\nSECURITY_REQUIREMENT: repair session isolation.\n" + pattern.repeat(4000) + "\nPreserve all behavior.";
	const input = context(text);
	input.messages.unshift({ role: "toolResult", content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }], timestamp: 0 });
	const h = await harness();
	assert.equal((await h.stream(input).result()).model, "gpt-6-astra");
	assert.equal(peak, 2);
	const chunks = requests.filter((request) => request.state.stage === "chunk").map((request) => request.state.chunk);
	assert.ok(chunks.length > 2 && chunks.length <= 8);
	const characters = Array.from(text);
	let end = 0, reconstructed = "";
	for (const chunk of chunks) {
		assert.ok(chunk.start <= end && chunk.end > end, "chunks cover all text with forward progress");
		assert.equal(chunk.text, characters.slice(chunk.start, chunk.end).join(""));
		reconstructed += Array.from(chunk.text).slice(end - chunk.start).join("");
		end = chunk.end;
	}
	assert.equal(reconstructed, text);
	assert.equal(requests.length, chunks.length + 1);
	assert.equal(h.calls[0].context, input);
	assert.doesNotMatch(JSON.stringify(requests), /PRIVATE|gateway-test-key|codex-test-key/);
	assert.equal(h.entries[0].data.routingChunks, chunks.length);
	assert.equal(h.entries[0].data.evaluationRequests, requests.length);
	assert.equal(h.entries[0].data.inputTokens, requests.length * 1000);
	assert.equal(h.entries[0].data.usageIncomplete, false);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	await h.stream(input).result();
	assert.equal(requests.length, chunks.length + 1, "continuations do not repeat the chunk pipeline");
});

test("chunked choices respect effort policies and monitoring never replaces the session pin", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: {
		options: { [FAST]: { description: "Routine work", thinking: { low: "Small changes", high: "Hard changes" } }, [DEEP]: { description: "Deep work", thinking: "high" } }, fallback: DEEP,
	} }));
	let desired = { target: FAST, thinking: "low" };
	const requests = mockGateway(t, (_options, body) => body.state.stage === "combined" ? desired : { target: DEEP, thinking: "high" });
	const h = await harness();
	await h.stream(context("x".repeat(40000))).result();
	assert.equal(h.calls[0].model.id, "gpt-5.6-luna");
	assert.equal(h.calls[0].options.reasoning, "low", "only the final combined effort is pinned");
	desired = { target: DEEP, thinking: "high" };
	await h.stream(context("y".repeat(40000), 2)).result();
	assert.equal(h.calls[1].model.id, "gpt-5.6-luna");
	assert.equal(h.calls[1].options.reasoning, "low");
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-suggestion").length, 1);
	assert.match(requests.at(-1).questions.route.instructions, /Prefer keeping it/);
	assert.deepEqual(Object.values(requests.at(-1).questions.route.criteria).map(({ model, thinking }) => [model, thinking]), [[DEEP, "high"], [FAST, "low"]]);
	await h.commands.get("jev").handler("", h.ctx);
	assert.match(h.notices.at(-1)[0], /evaluations: \d+, chunks planned: \d+/);
	const completed = requests.length;
	await h.stream(context("z".repeat(40000), 3)).result();
	assert.equal(requests.length, completed, "suggested alternatives remain suppressed for long prompts too");
});

test("route descriptions and JSON escaping count toward every request budget", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const config = { options: { [FAST]: { description: "a".repeat(10000) }, [DEEP]: { description: "b".repeat(10000) } }, fallback: DEEP };
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const requests = mockGateway(t, (_options, body) => {
		assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 28_000);
		return FAST;
	});
	const h = await harness();
	assert.equal((await h.stream(context("x".repeat(10000))).result()).model, "gpt-5.6-luna");
	assert.equal(requests.at(-1).state.stage, "combined", "a short task can still need chunks when criteria are large");
	const completed = requests.length;
	config.options[FAST].description = "x".repeat(30000);
	writeFileSync(settingsPath, JSON.stringify({ jevRouter: config }));
	const oversized = await harness();
	assert.equal((await oversized.stream().result()).model, "gpt-6-astra");
	assert.match(oversized.entries[0].data.reason, /insufficient room/);
	assert.equal(requests.length, completed, "an impossible criteria budget must not send requests");
});

test("oversized inputs and excessive chunk plans fall back before any evaluation", async (t) => {
	const requests = mockGateway(t);
	for (const [text, reason] of [["x".repeat(192001), /192000-byte routing limit/], ["\u0000".repeat(50000), /more than 8 routing chunks/]]) {
		const h = await harness();
		const input = context(text);
		assert.equal((await h.stream(input).result()).model, "gpt-6-astra");
		assert.equal(h.calls[0].context, input);
		assert.match(h.entries[0].data.reason, reason);
	}
	assert.equal(requests.length, 0);
	const pinned = await harness();
	await pinned.stream().result();
	assert.equal((await pinned.stream(context("x".repeat(192001), 2)).result()).model, "gpt-5.6-luna");
	assert.match(pinned.entries.findLast((entry) => entry.name === "jev-monitor").data.reason, /routing limit/);
	assert.equal(requests.length, 1, "an over-budget monitor keeps the pin without making calls");
});

test("a failed chunk cancels its sibling and never combines a partial result", async (t) => {
	const siblingStarted = Promise.withResolvers();
	let siblingAborted = false;
	const requests = mockGateway(t, async (options, body) => {
		assert.equal(body.state.stage, "chunk");
		if (body.state.chunk.index === 0) {
			await siblingStarted.promise;
			return Response.json({ error: "PRIVATE FAILED CHUNK BODY" }, { status: 503 });
		}
		return new Promise((_, reject) => {
			options.signal.addEventListener("abort", () => { siblingAborted = true; reject(options.signal.reason); }, { once: true });
			siblingStarted.resolve();
		});
	});
	const h = await harness();
	assert.equal((await h.stream(context("x".repeat(80000))).result()).model, "gpt-6-astra");
	assert.equal(requests.length, 2);
	assert.equal(siblingAborted, true);
	assert.equal(h.entries[0].data.source, "fallback");
	assert.equal(h.entries[0].data.usageIncomplete, true);
	assert.match(h.entries[0].data.reason, /HTTP 503/);
	assert.doesNotMatch(JSON.stringify(h.entries) + JSON.stringify(h.notices), /PRIVATE FAILED CHUNK BODY/);
});

test("cancellation during chunking or combination never generates or saves a pin", async (t) => {
	let phase, started;
	mockGateway(t, (options, body) => body.state.stage === phase ? new Promise((_, reject) => {
		started.resolve();
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	}) : FAST);
	for (phase of ["chunk", "combined"]) {
		started = Promise.withResolvers();
		const h = await harness();
		const controller = new AbortController();
		const pending = h.stream(context("x".repeat(50000)), { signal: controller.signal }).result();
		await started.promise;
		controller.abort();
		assert.equal((await pending).stopReason, "aborted");
		assert.equal(h.calls.length, 0);
		assert.equal(h.entries.length, 0);
	}
});

test("one overall deadline bounds chunks, combination, and retries while retaining reported usage", async (t) => {
	const deadline = new AbortController();
	let deadlines = 0;
	t.mock.method(AbortSignal, "timeout", (ms) => {
		if (ms === 15000) { deadlines++; return deadline.signal; }
		assert.equal(ms, 5000);
		return new AbortController().signal;
	});
	const combining = Promise.withResolvers();
	const requests = mockGateway(t, (options, body) => body.state.stage === "combined" ? new Promise((_, reject) => {
		combining.resolve();
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	}) : FAST);
	const h = await harness();
	const pending = h.stream(context("x".repeat(50000))).result();
	await combining.promise;
	deadline.abort(new DOMException("Routing deadline", "TimeoutError"));
	assert.equal((await pending).model, "gpt-6-astra");
	assert.equal(deadlines, 1);
	assert.equal(requests.filter((request) => request.state.stage === "combined").length, 1, "a spent deadline must never retry");
	assert.equal(h.entries[0].data.reason, "Jev timed out");
	assert.equal(h.entries[0].data.inputTokens, (requests.length - 1) * 1000);
	assert.equal(h.entries[0].data.evaluationRequests, requests.length);
	assert.equal(h.entries[0].data.usageIncomplete, true);
});

test("cancellation during evaluation or auth never falls through to inference or retains a cancelled choice", async (t) => {
	const started = Promise.withResolvers();
	let hanging = true;
	const requests = mockGateway(t, (options) => hanging ? new Promise((_, reject) => {
		started.resolve();
		options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
	}) : FAST);
	const h = await harness();
	const controller = new AbortController();
	const pending = h.stream(context(), { signal: controller.signal }).result();
	await started.promise;
	controller.abort();
	assert.equal((await pending).stopReason, "aborted");
	assert.equal(h.calls.length, 0);
	assert.equal(h.entries.length, 0);
	hanging = false;
	assert.equal((await h.stream().result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 2, "a cancelled evaluation must not pin a choice");

	const authStarted = Promise.withResolvers();
	const auth = await harness({ refs: [FAST], auth: () => { authStarted.resolve(); return new Promise(() => {}); } });
	const authController = new AbortController();
	const authPending = auth.stream(context(), { signal: authController.signal }).result();
	await authStarted.promise;
	authController.abort();
	assert.equal((await authPending).stopReason, "aborted");
	assert.equal(auth.calls.length, 0);
	assert.equal(auth.entries.filter((entry) => entry.name === "jev-pin").length, 0, "auth cancellation must not persist a pin");
	assert.equal((await h.stream(context(), { signal: AbortSignal.abort() }).result()).stopReason, "aborted");
});

test("evaluation retries twice after timeouts before succeeding", async (t) => {
	const originalTimeout = AbortSignal.timeout;
	t.mock.method(AbortSignal, "timeout", (ms) => {
		assert.ok(ms === 5000 || ms === 15000);
		return originalTimeout(ms === 5000 ? 10 : 1000);
	});
	let attempts = 0;
	const requests = mockGateway(t, (options) => ++attempts < 3 ? delay(1000, FAST, { signal: options.signal }) : FAST);
	const h = await harness();
	assert.equal((await h.stream().result()).model, "gpt-5.6-luna");
	assert.equal(requests.length, 3);
	assert.equal(h.entries[0].data.source, "jev");
});

test("evaluation timeouts fall back, while authentication failures expose only the HTTP status", async (t) => {
	const originalTimeout = AbortSignal.timeout;
	t.mock.method(AbortSignal, "timeout", (ms) => {
		assert.ok(ms === 5000 || ms === 15000);
		return originalTimeout(ms === 5000 ? 10 : 1000);
	});
	let rejectAuth = false;
	mockGateway(t, (options) => rejectAuth ? Response.json({ error: "SECRET ERROR BODY" }, { status: 401 }) : delay(1000, FAST, { signal: options.signal }));
	const h = await harness();
	assert.equal((await h.stream().result()).model, "gpt-6-astra");
	assert.equal(h.entries[0].data.reason, "Jev timed out");
	rejectAuth = true;
	assert.equal((await h.stream(context("Next", 2)).result()).model, "gpt-6-astra");
	assert.match(h.entries.findLast((entry) => entry.name === "jev-monitor").data.reason, /credentials \(401\)/);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-pin").length, 1);
	assert.equal(h.entries.filter((entry) => entry.name === "jev-suggestion").length, 0);
	assert.doesNotMatch(JSON.stringify(h.notices), /SECRET ERROR BODY/);
});

test("a pinned text-only model cannot silently receive images from later tool results", async (t) => {
	mockGateway(t);
	const h = await harness();
	h.models[0].input = ["text"];
	await h.stream().result();
	const input = context();
	input.messages.push({ role: "toolResult", toolCallId: "image", toolName: "read", content: [{ type: "image", data: "image", mimeType: "image/png" }], timestamp: 2 });
	const result = await h.stream(input).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /pinned Jev route/);
	assert.equal(h.calls.length, 1);
});

test("backend errors are forwarded without switching models; incomplete streams fail instead of hanging", async (t) => {
	mockGateway(t);
	const h = await harness({ backendError: true });
	const result = await h.stream().result();
	assert.equal(result.errorMessage, "Backend failure");
	assert.equal(result.model, "gpt-5.6-luna");
	assert.equal(h.calls.length, 1);
	const broken = await harness({ incomplete: true });
	assert.match((await broken.stream().result()).errorMessage, /without a terminal event/);
	const expired = await harness({ auth: async () => ({ ok: false, error: "PRIVATE AUTH DETAILS" }) });
	assert.match((await expired.stream().result()).errorMessage, /Authentication failed/);
	assert.equal(expired.calls.length, 0);
});

test("loads global jevRouter settings without merging default routes, and reloads changes", async (t) => {
	t.after(() => rmSync(settingsPath, { force: true }));
	const custom = { options: { [FAST]: { description: "Custom route", thinking: "low" } }, fallback: FAST, timeoutMs: 1000 };
	const original = "\uFEFF" + JSON.stringify({ theme: "dark", jevRouter: custom });
	writeFileSync(settingsPath, original);
	const h = await harness();
	assert.equal((await h.stream().result()).model, "gpt-5.6-luna");
	assert.equal(h.calls[0].options.reasoning, "low");
	await h.commands.get("jev").handler("", h.ctx);
	assert.ok(h.notices.at(-1)[0].includes(`Config: ${settingsPath} (jevRouter)`));
	assert.ok(h.notices.at(-1)[0].includes(`Edit jevRouter in ${settingsPath}, then /reload.`));
	assert.ok(!h.notices.at(-1)[0].includes(DEEP));
	assert.equal(readFileSync(settingsPath, "utf8"), original, "loading must not rewrite unrelated settings");

	writeFileSync(settingsPath, JSON.stringify({ jevRouter: { options: { [DEEP]: { description: "Changed route" } }, fallback: DEEP } }));
	const reloaded = await harness();
	assert.equal((await reloaded.stream().result()).model, "gpt-6-astra");
	writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
	const defaults = await harness({ refs: [FAST] });
	assert.equal((await defaults.stream().result()).model, "gpt-5.6-luna");
	assert.equal(defaults.calls[0].options.reasoning, "max");
});

test("invalid global settings fail instead of using other routes or exposing JSON contents", async (t) => {
	t.after(() => rmSync(settingsPath, { recursive: true, force: true }));
	for (const value of [null, [], { jevRouter: null }, { jevRouter: {} }, { jevRouter: { options: {}, fallback: FAST } }]) {
		writeFileSync(settingsPath, JSON.stringify(value));
		await assert.rejects(harness(), /Expected a JSON object|Jev configuration requires|Jev fallback/);
	}
	writeFileSync(settingsPath, '{"privateKey":"DO_NOT_EXPOSE", BROKEN');
	await assert.rejects(harness(), (error) => {
		assert.equal(error.message, `Invalid JSON in ${settingsPath}.`);
		assert.doesNotMatch(error.message, /DO_NOT_EXPOSE|BROKEN/);
		return true;
	});
});

test("validates config and bounds routing text without sending thinking, tools, images or the system prompt", () => {
	for (const config of [null, {}, { options: {}, fallback: FAST }, { options: { "auto/jev": { description: "loop" } }, fallback: "auto/jev" }, { options: { [FAST]: { description: "fast", thinking: "nonsense" } }, fallback: FAST }]) {
		assert.throws(() => parseConfig(config));
	}
	assert.throws(() => parseConfig({ options: { [FAST]: { description: "fast" } }, fallback: FAST, timeoutMs: Infinity }));
	for (const monitor of [null, "false", 0, {}]) {
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "fast" } }, fallback: FAST, monitor }), /monitor must be a boolean/);
	}
	for (const thinking of [null, [], {}, { low: "" }, { low: 1 }, { turbo: "Fast" }]) {
		assert.throws(() => parseConfig({ options: { [FAST]: { description: "fast", thinking } }, fallback: FAST }));
	}
	for (const thinking of ["auto", "off", { low: "Simple", high: "Complex" }]) {
		assert.deepEqual(parseConfig({ options: { [FAST]: { description: "fast", thinking } }, fallback: FAST }).options[FAST].thinking, thinking);
	}
	const input = context("latest", 100);
	input.messages.unshift(...Array.from({ length: 20 }, (_, i) => user(`earlier ${i}`, i)));
	assert.equal(routingInput(input).messages.length, 8);
	const rich = context();
	rich.messages.unshift({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE REASONING" }, { type: "text", text: "Previous answer" }], timestamp: 0 });
	assert.deepEqual(routingInput(rich).messages, [{ role: "assistant", text: "Previous answer" }, { role: "user", text: "Fix a typo" }]);
	assert.equal(routingInput(context("x".repeat(16001))).messages[0].text.length, 16001);
	assert.match(routingInput(context("x".repeat(192001))).reason, /routing limit/);
});

// Opt-in integration test: run laya-server.py, then set LAYA_TEST_URL.
test("live Laya full routing", { skip: !process.env.LAYA_TEST_URL }, async (t) => {
 const previous = globalThis.fetch;
 globalThis.fetch = liveFetch;
 t.after(() => { globalThis.fetch = previous; });
 configureSkills(t, { apiUrl: process.env.LAYA_TEST_URL, options: { [FAST]: { description: "Simple edits" }, [DEEP]: { description: "Complex reasoning" } }, fallback: DEEP, skills: false, timeoutMs: 60000 });
 const h = await harness({ gatewayKey: false });
 await h.stream(context("Fix a typo in README.md")).result();
 const route = h.entries.find(e => e.name === "jev-route").data;
 assert.equal(route.source, "jev");
 assert.equal(route.target, FAST);
 const deep = await harness({ gatewayKey: false });
 await deep.stream(context("Investigate a subtle distributed concurrency bug and evaluate architectural tradeoffs.")).result();
 const complexRoute = deep.entries.find(e => e.name === "jev-route").data;
 assert.equal(complexRoute.source, "jev");
 assert.equal(complexRoute.target, DEEP);
});
