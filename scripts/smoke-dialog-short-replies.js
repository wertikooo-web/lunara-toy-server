'use strict';

const assert = require('assert');
const dialogState = require('../modules/dialogState');
const orchestrator = require('../modules/conversationOrchestrator');

assert.strictEqual(dialogState.isAffirmative('да'), true);
assert.strictEqual(dialogState.isAffirmative('угу'), true);
assert.strictEqual(dialogState.isAffirmative('ага'), true);
assert.strictEqual(dialogState.isAffirmative('хорошо'), true);
assert.strictEqual(dialogState.isAffirmative('ну да'), true);
assert.strictEqual(dialogState.isUncertain('не знаю'), true);
assert.strictEqual(dialogState.isHesitation('ну'), true);

const riddleState = orchestrator.createState();
riddleState.pendingOffer = { type: 'riddle', createdAt: Date.now(), source: 'test' };
let decision = orchestrator.detectDecision('да', riddleState);
assert.strictEqual(decision.reason, 'accepted_pending_offer');
assert.strictEqual(decision.type, 'riddle');
assert.strictEqual(decision.rewrittenText, 'Загадай загадку');

const chatState = orchestrator.createState();
orchestrator.rememberBotReply(chatState, 'Какую пиццу ты любишь больше всего?', { type: 'chat' });
decision = orchestrator.detectDecision('не знаю', chatState);
assert.strictEqual(decision.reason, 'short_reply_with_context');
assert.strictEqual(decision.action, 'llm');
assert.ok(decision.rewrittenText.includes('неуверенность'));

const yesState = orchestrator.createState();
orchestrator.rememberBotReply(yesState, 'Хочешь интересный факт?', { type: 'fact' });
decision = orchestrator.detectDecision('угу', yesState);
assert.strictEqual(decision.reason, 'accepted_pending_offer');
assert.strictEqual(decision.type, 'fact');

console.log('[Smoke] dialog short replies ok');
