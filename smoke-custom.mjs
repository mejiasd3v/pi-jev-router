import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { experimental_evaluate as evaluate } from 'ai';
const require = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piAi = require.resolve.paths('@earendil-works/pi-ai').map(p => join(p, '@earendil-works/pi-ai/dist/compat.js')).find(existsSync);
const { createJiti } = require('jiti');
const { customEvaluationModel, parseConfig } = await createJiti(import.meta.url, { alias: { '@earendil-works/pi-ai': piAi } }).import('./index.ts');
const settings = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'settings.json'), 'utf8'));
const config = parseConfig(settings.jevRouter);
assert.ok(config.apiUrl, 'Configure jevRouter.apiUrl first');
const result = await evaluate({ model: customEvaluationModel(config.apiUrl), state: { task: 'Fix a typo in README.md.' }, questions: {
 route: { type: 'choice', instructions: 'Select the best model for this task.', criteria: Object.fromEntries(Object.entries(config.options).map(([id, option]) => [id, option.description])) },
 skill: { type: 'boolean', instructions: 'Does this task require a database migration skill?', criteria: { true: 'A database migration is required.', false: 'No database migration is required.' } },
 effort: { type: 'choice', instructions: 'Choose sufficient reasoning effort.', criteria: { low: 'Straightforward typo correction.', high: 'Complex architectural investigation.' } },
}, abortSignal: AbortSignal.timeout(config.timeoutMs), maxRetries: 0 });
assert.ok(Object.hasOwn(config.options, result.answers.route.choice));
assert.ok(result.answers.skill.probability < 0.5);
assert.equal(result.answers.effort.choice, 'low');
console.log(JSON.stringify({ endpoint: config.apiUrl, answers: result.answers, usage: result.usage }, null, 2));
