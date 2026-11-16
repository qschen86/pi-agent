import { createInterface } from 'node:readline';
const reply = (msg, data = {}) => process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, command: msg.type, success: true, data }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'slow') return setTimeout(() => reply(m, { value: 'slow' }), 40);
  if (m.type === 'never') return;
  if (m.type === 'linger') {
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 40));
    return reply(m);
  }
  if (m.type === 'fail') return process.stdout.write(JSON.stringify({ type: 'response', id: m.id, command: m.type, success: false, error: 'model unavailable' }) + '\n');
  if (m.type === 'quit') return process.exit(8);
  if (m.type === 'malformed') return process.stdout.write('invalid json\n');
  if (m.type === 'huge') return process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  if (m.type === 'screenshot_run' || m.type === 'huge_message_end') {
    // A Playwright-style run: base64 screenshots push the summary frame past 2 MiB.
    const shot = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo'.padEnd(800 * 1024, 'A') };
    const result = { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'shot.png' }, shot] };
    if (m.type === 'huge_message_end') {
      reply(m);
      return process.stdout.write(JSON.stringify({ type: 'message_end', message: { ...result, content: [shot, shot, shot] } }) + '\n');
    }
    reply(m);
    process.stdout.write(JSON.stringify({ type: 'message_end', message: result }) + '\n');
    const turnEnd = Buffer.from(JSON.stringify({ type: 'turn_end', message: result, toolResults: [result, result, result] }) + '\n');
    const agentEnd = Buffer.from(JSON.stringify({ type: 'agent_end', messages: [result, result, result] }) + '\n');
    const settled = Buffer.from(JSON.stringify({ type: 'agent_settled' }) + '\n');
    // turn_end arrives in one write; agent_end trickles in and shares its last chunk with agent_settled.
    process.stdout.write(turnEnd);
    const tail = Buffer.concat([agentEnd, settled]);
    let at = 0;
    const next = () => {
      if (at >= tail.length) return;
      process.stdout.write(tail.subarray(at, at += 300 * 1024));
      setTimeout(next, 2);
    };
    return next();
  }
  if (m.type === 'read_screenshot') {
    // A real read of a full-page screenshot: Pi mirrors the image into structuredContent,
    // so tool_execution_end is twice the message frame that follows it.
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo'.padEnd(1100 * 1024, 'A') };
    const note = 'Read image file [image/png]';
    const result = { content: [{ type: 'text', text: note }, image], details: {}, structuredContent: { type: 'image', mimeType: 'image/png', data: image.data, note } };
    reply(m);
    process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: '/tmp/shot.png' } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', isError: false, result }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: note }, image], isError: false } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
    return;
  }
  if (m.type === 'unicode') {
    const content = JSON.stringify({ type: 'message_update', text: '半行🧪\u2028分隔\u2029完整' }) + '\r\n';
    const bytes = Buffer.from(content);
    // Split inside the four-byte emoji to exercise UTF-8 reassembly.
    const split = bytes.indexOf(Buffer.from('🧪')) + 2;
    process.stdout.write(bytes.subarray(0, split));
    return setTimeout(() => { process.stdout.write(bytes.subarray(split)); reply(m); }, 10);
  }
  if (m.type === 'prompt') {
    reply(m);
    for (const type of ['agent_end', 'auto_retry_start', 'agent_start', 'agent_settled']) process.stdout.write(JSON.stringify({ type }) + '\n');
    return;
  }
  if (m.type === 'extension_ui_response') return process.stdout.write(JSON.stringify({ type: 'ui_result', ...m, requestType: m.type, type: 'ui_result' }) + '\n');
  reply(m, { value: m.type });
});
