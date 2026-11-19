import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { ONBOARDING_KIND, ONBOARDING_MARK, ONBOARDING_REPLIES, onboardingPrompt, onboardingRepliesFor } from '../src/onboarding.mjs';

test('the hidden trigger mark is identical in the server prompt and the web UI', () => {
  const source = readFileSync(resolve('apps/web/public/runtime-chat.js'), 'utf8');
  const declaration = /const RT_ONBOARDING_MARK = ("[^"]+");/.exec(source)?.[1];
  assert.ok(declaration, 'the UI declares the onboarding mark');
  assert.equal(vm.runInNewContext(declaration), ONBOARDING_MARK);
  assert.ok(onboardingPrompt().startsWith(ONBOARDING_MARK));
});

test('preset first tasks respect the quick-reply limits', () => {
  assert.ok(ONBOARDING_REPLIES.length >= 1 && ONBOARDING_REPLIES.length <= 3, 'at most three capsules');
  for (const reply of ONBOARDING_REPLIES) {
    assert.ok(reply.label.length <= 24, reply.label); assert.ok(reply.text.length <= 500, reply.text);
    assert.ok(reply.text.length > reply.label.length, 'sending the text is more specific than the label');
  }
  assert.equal(new Set(ONBOARDING_REPLIES.map(r => r.text)).size, ONBOARDING_REPLIES.length);
});

test('the welcome prompt asks the model to introduce itself and wait, without building anything yet', () => {
  const prompt = onboardingPrompt();
  assert.match(prompt, /pi-agent/); assert.match(prompt, /先不要动手/); assert.match(prompt, /不要访问外部网站/);
  for (const reply of ONBOARDING_REPLIES) assert.ok(prompt.includes(reply.label.slice(0, 4)), `mentions ${reply.label}`);
});

test('fixed replies apply only to the welcome session, only until the user replies', () => {
  const installation = { acceptance: { taskKind: ONBOARDING_KIND, taskSession: 'rt-welcome' } };
  assert.equal(onboardingRepliesFor(installation, 'rt-welcome', 1)?.length, ONBOARDING_REPLIES.length);
  assert.equal(onboardingRepliesFor(installation, 'rt-welcome', 2), undefined, 'after the user replies, normal extraction resumes');
  assert.equal(onboardingRepliesFor(installation, 'rt-other', 1), undefined, 'other sessions are untouched');
  assert.equal(onboardingRepliesFor({ acceptance: { taskSession: 'rt-welcome' } }, 'rt-welcome', 1), undefined, 'the sample-task flow is untouched');
  assert.equal(onboardingRepliesFor(undefined, 'rt-welcome', 1), undefined);
  // Callers must not be able to mutate the shared presets.
  onboardingRepliesFor(installation, 'rt-welcome', 1)[0].label = 'changed';
  assert.notEqual(ONBOARDING_REPLIES[0].label, 'changed');
});
