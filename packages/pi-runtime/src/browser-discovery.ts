/** Frontend SDK: query runtime-owned display metadata without opening operator configuration. */
import type { BrowserProfileOption } from './browser-catalog.js';
export async function queryBrowserProfiles(run:(args:string[])=>Promise<string>):Promise<BrowserProfileOption[]|undefined>{
  const describe=JSON.parse(await run(['--describe']));
  if(describe.browserProfileSelection!==1)return;
  const result=JSON.parse(await run(['--browser-profiles']));
  if(result?.version!==1||!Array.isArray(result.profiles)||!result.profiles.length||result.profiles.length>33)throw new Error('Invalid runtime browser discovery');
  const ids=new Set<string>();
  for(const p of result.profiles){
    if(!p||typeof p.id!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(p.id)||ids.has(p.id)||typeof p.label!=='string'||!p.label.trim()||p.label.length>80||typeof p.persistent!=='boolean'||Object.keys(p).some(k=>!['id','label','persistent'].includes(k)))throw new Error('Invalid runtime browser metadata');
    ids.add(p.id);
  }
  if(result.profiles[0].id!=='isolated'||result.profiles[0].persistent)throw new Error('Runtime must default to isolated browser');
  return result.profiles;
}
