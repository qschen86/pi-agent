import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect,it} from "vitest";
import {CodexAppServerClient,type CodexClientOptions} from "../src/codex-client.js";
it("starts the actual app-server child inside its isolated cwd rather than inheriting the host repository",async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"codex-client-cwd-")),fixture=join(dirname(fileURLToPath(import.meta.url)),"fixtures/fake-app-server.mjs");
 const client=new CodexAppServerClient({binaryPath:process.execPath,args:[fixture],cwd} as CodexClientOptions);let exited!:()=>void;const exit=new Promise<void>(resolve=>exited=resolve);client.once("exit",exited);
 try{await client.start();expect(await client.request("debug/cwd",{})).toEqual({cwd:realpathSync(cwd)});}finally{client.stop();await exit;rmSync(cwd,{recursive:true,force:true});}
});
