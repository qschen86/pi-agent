import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installPreviewStorage, startPreviewStorage, renderStatefulPreview } from '../src/preview-storage.mjs';

function child(values = {}, persistence, XMLHttpRequest) {
  const messages = [];
  const listeners = new Map();
  const context = vm.createContext({
    TextEncoder, DOMException, Event, XMLHttpRequest,
    parent: { postMessage: value => messages.push(value) },
    window: { addEventListener: (type, listener) => listeners.set(type, listener), dispatchEvent() {} }
  });
  vm.runInContext(`(${installPreviewStorage.toString()})('test-channel', ${JSON.stringify(values)}, ${JSON.stringify(persistence ?? null)})`, context);
  return { storage: context.window.localStorage, messages };
}

test('generated localStorage calls restore saved values and send bounded updates', () => {
  const { storage, messages } = child({ plan: '{"first":true}' });
  assert.equal(storage.getItem('plan'), '{"first":true}');
  assert.equal(storage.getItem('console-session'), null);
  storage.setItem('plan', '{"first":false}');
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), 'plan');
  assert.equal(messages.at(-1).operation, 'set');
  storage.extra = 42;
  assert.equal(storage.extra, '42');
  delete storage.extra;
  assert.equal(storage.getItem('extra'), null);
  assert.throws(() => storage.setItem('large', 'x'.repeat(32769)), { name: 'QuotaExceededError' });
  storage.clear();
  assert.equal(storage.length, 0);
  assert.equal(messages.at(-1).operation, 'clear');
});

test('outer preview accepts its own frame only and persists inside one artifact namespace', () => {
  const saved = new Map([['console-session', 'private'], ['artifact-a', '{"plan":"old"}'], ['artifact-b', '{"plan":"other"}']]);
  const listeners = new Map();
  const frame = { contentWindow: { postMessage() {} }, srcdoc: '' };
  const status = { hidden: true };
  const context = vm.createContext({
    TextEncoder,
    document: { getElementById: id => id === 'artifact-preview' ? frame : status },
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  });
  vm.runInContext(`(${startPreviewStorage.toString()})('artifact-a', '<h1>plan</h1>', 'channel-a', 'function(){}')`, context);
  const receive = (source, channel, operation, key, value) => listeners.get('message')({ source, data: { channel, operation, key, value } });
  receive({}, 'channel-a', 'set', 'plan', 'spoofed');
  receive(frame.contentWindow, 'wrong-channel', 'set', 'plan', 'spoofed');
  assert.equal(saved.get('artifact-a'), '{"plan":"old"}');
  receive(frame.contentWindow, 'channel-a', 'set', 'plan', 'saved');
  assert.equal(JSON.parse(saved.get('artifact-a')).plan, 'saved');
  receive(frame.contentWindow, 'channel-a', 'clear');
  assert.equal(saved.get('artifact-a'), '{}');
  assert.equal(saved.get('artifact-b'), '{"plan":"other"}');
  assert.equal(saved.get('console-session'), 'private');
  assert.equal(status.hidden, true);
});

test('untrusted document markup cannot escape into the trusted storage wrapper', () => {
  const hostile = '</script><script>parent.localStorage.clear()</script>';
  const rendered = renderStatefulPreview(hostile, 'artifact-a');
  assert.equal((rendered.match(/<script>/g) || []).length, 1);
  assert.equal((rendered.match(/<\/script>/g) || []).length, 1);
  assert.equal(rendered.includes(hostile), false);
  assert.match(rendered, /sandbox="allow-scripts"/);
  assert.equal(rendered.includes('allow-same-origin'), false);
});

 test('synchronous host save finishes before mutation returns; failed saves keep old values', () => {
  const calls=[];
  class Request {
    status=200;
    open(method,url,async){ calls.push({method,url,async}); }
    setRequestHeader(){}
    send(body){ calls.push(JSON.parse(body)); }
  }
  const {storage}=child({done:'no'},{url:'http://localhost/state'},Request);
  storage.setItem('done','yes');
  assert.equal(calls[0].async,false);
  assert.equal(calls[1].value,'yes');
  assert.equal(storage.getItem('done'),'yes');
  class FailedRequest extends Request { status=500; }
  const failed=child({done:'no'},{url:'http://localhost/state'},FailedRequest);
  assert.throws(()=>failed.storage.setItem('done','yes'),{name:'InvalidStateError'});
  assert.equal(failed.storage.getItem('done'),'no');
  assert.equal(failed.messages.at(-1).operation,'error');
});
