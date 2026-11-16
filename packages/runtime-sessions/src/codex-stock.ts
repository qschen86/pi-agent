/** Host-owned receipt of pristine native stock resources, never an evaluation qualification. */
import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,readdirSync,readFileSync,realpathSync} from "node:fs";
import {join,relative} from "node:path";
import {allowlistedEnv,type CodexAppServerClient,type CodexClientOptions} from "./codex-client.js";
import {CODEX_EVALUATION_ARGS} from "./codex-boundary.js";
export interface CodexStockManifest {files:Array<{path:string;size:number;hash:string}>;hash:string;}
const digest=(files:CodexStockManifest["files"])=>"sha256:"+createHash("sha256").update(JSON.stringify(files)).digest("hex");
export function validCodexStock(value:unknown):value is CodexStockManifest {
 const m=value as CodexStockManifest;
 return !!m && Object.keys(m).sort().join(",")==="files,hash" && Array.isArray(m.files) && m.files.length>0 && m.files.length<=512 && m.files.every(f=>f && Object.keys(f).sort().join(",")==="hash,path,size" && typeof f.path==="string" && f.path.length>0 && f.path.length<=512 && !/[\\\x00-\x1f]/.test(f.path) && f.path.split("/").every(p=>p.length>0&&p!=="."&&p!=="..") && Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=2*1024*1024 && /^sha256:[a-f0-9]{64}$/.test(f.hash)) && new Set(m.files.map(f=>f.path)).size===m.files.length && m.files.reduce((n,f)=>n+f.size,0)<=8*1024*1024 && m.hash===digest(m.files);
}
export function scanCodexStock(codexHome:string):CodexStockManifest {
 const root=join(codexHome,"skills"),files:CodexStockManifest["files"]=[];let bytes=0;
 function walk(dir:string){if(lstatSync(dir).isSymbolicLink()||realpathSync(dir)!==dir)throw new Error("Codex stock directory linked or changed");for(const name of readdirSync(dir).sort()){const file=join(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink())throw new Error("Codex stock resource is linked");if(stat.isDirectory())walk(file);else if(stat.isFile()&&stat.nlink===1&&stat.size<=2*1024*1024){bytes+=stat.size;if(bytes>8*1024*1024||files.length>=512)throw new Error("Codex stock resource limits exceeded");files.push({path:relative(root,file),size:stat.size,hash:"sha256:"+createHash("sha256").update(readFileSync(file)).digest("hex")});}else throw new Error("Codex stock resource is not a bounded regular file");}}
 walk(root);const m={files,hash:digest(files)};if(!validCodexStock(m))throw new Error("Codex stock manifest invalid or empty");return m;
}
export function verifyCodexStock(codexHome:string,manifest:CodexStockManifest):void {
 if(!validCodexStock(manifest)||scanCodexStock(codexHome).hash!==manifest.hash)throw new Error("Codex trusted stock resources changed; original realm held");
}
export async function bootstrapCodexStock(runtimeRoot:string,bin:string,create:(options:CodexClientOptions)=>CodexAppServerClient):Promise<CodexStockManifest>{
 if(lstatSync(runtimeRoot).isSymbolicLink()||realpathSync(runtimeRoot)!==runtimeRoot||readdirSync(runtimeRoot).length!==0)throw new Error("Codex trusted bootstrap requires pristine original realm; never rerun on populated state");
 const home=join(runtimeRoot,"home"),codexHome=join(home,".codex"),tmp=join(runtimeRoot,"tmp");mkdirSync(codexHome,{recursive:true,mode:0o700});mkdirSync(tmp,{mode:0o700});
 const c=create({binaryPath:bin,args:[...CODEX_EVALUATION_ARGS],cwd:tmp,env:allowlistedEnv({HOME:home,CODEX_HOME:codexHome,TMPDIR:tmp})});
 let exit!: {code:number|null;stderrTail:string};const exited=new Promise<void>(resolve=>c.once("exit",info=>{exit=info;resolve();}));
 try {await c.start();const r=await c.request("skills/list",{cwds:[tmp],forceReload:true}) as {data?:Array<{errors?:unknown[]}>};if(r.data?.some(e=>e.errors?.length))throw new Error("Codex stock discovery reported errors");}
 finally {c.stop();await exited;}
 if(exit.code!==0||exit.stderrTail.includes("failed to install system skills"))throw new Error("Codex trusted stock bootstrap did not exit cleanly");
 return scanCodexStock(codexHome);
}
