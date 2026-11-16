import {screenshotViolation} from './screenshot-policy.mjs';
let input='';
for await (const chunk of process.stdin) {input+=chunk;if(input.length>4*1024*1024){process.stderr.write('Screenshot policy input too large');process.exit(2);}}
try {
 const value=JSON.parse(input), reason=screenshotViolation(value.tool_name,value.tool_input,value.cwd);
 if(reason)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}));
 else process.stdout.write('{}');
} catch {process.stderr.write('Screenshot policy invalid input');process.exitCode=2;}
