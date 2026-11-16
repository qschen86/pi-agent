/** Operator-owned browser configuration catalog. Frontends receive IDs and labels only. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
export interface BrowserProfileOption { id:string; label:string; persistent:boolean }
interface Entry {id:string;label:string;profile:string}
const isolated:BrowserProfileOption={id:'isolated',label:'临时隔离',persistent:false};
function entries(file:string):Entry[]{
  if(!existsSync(file))return [];
  const st=lstatSync(file);
  if(!isAbsolute(file)||!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid())||st.size>65536)throw new Error('Browser catalog must be a private operator-owned file');
  const raw=JSON.parse(readFileSync(file,'utf8'));
  if(raw?.version!==1||!Array.isArray(raw.profiles)||raw.profiles.length>32||Object.keys(raw).some(k=>!['version','profiles'].includes(k)))throw new Error('Invalid browser catalog');
  const ids=new Set(['isolated']);
  return raw.profiles.map((e:Entry)=>{
    if(!e||typeof e.id!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(e.id)||ids.has(e.id)||typeof e.label!=='string'||!e.label.trim()||e.label.length>80||typeof e.profile!=='string'||!isAbsolute(e.profile)||Object.keys(e).some(k=>!['id','label','profile'].includes(k)))throw new Error('Invalid or duplicate browser profile ID');
    ids.add(e.id);
    const stat=lstatSync(e.profile);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)!==0||(process.getuid&&stat.uid!==process.getuid())||stat.size>65536)throw new Error('Browser configuration must be operator-owned');
    const profile=JSON.parse(readFileSync(e.profile,'utf8'));
    if(typeof profile?.browser?.profileRoot!=='string'||!isAbsolute(profile.browser.profileRoot))throw new Error('Browser catalog entries must be persistent configurations');
    return {id:e.id,label:e.label.trim(),profile:e.profile};
  });
}
export function listBrowserProfiles(file:string):BrowserProfileOption[]{return [{...isolated},...entries(file).map(e=>({id:e.id,label:e.label,persistent:true}))];}
export function selectBrowserProfile(input:{catalogFile:string;baseProfile?:string;requestedId?:string;sessionFile?:string}):{id:string;profile?:string}{
  let pinned:string|undefined, legacyHistory=false;
  if(input.sessionFile){
    const rows=readFileSync(input.sessionFile,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
    const records=rows.filter(r=>r.type==='custom'&&r.customType==='pi-runtime-browser');
    legacyHistory=records.length===0;
    pinned=records.length?records[0]?.data?.id:'isolated';
    if(typeof pinned!=='string'||records.some(r=>r.data?.id!==pinned))throw new Error('Invalid fixed browser configuration in native history');
    if(input.requestedId!==undefined&&input.requestedId!==pinned)throw new Error('Browser configuration is fixed for this session; create a new session to switch');
  }
  const id=pinned??input.requestedId??'isolated';
  if(id==='isolated'){
    if(!legacyHistory&&input.baseProfile&&JSON.parse(readFileSync(input.baseProfile,'utf8'))?.browser?.profileRoot!==undefined)throw new Error('Default isolated configuration cannot use a persistent browser profile');
    return {id,profile:input.baseProfile};
  }
  const selected=entries(input.catalogFile).find(e=>e.id===id);
  if(!selected)throw new Error('Selected browser configuration is unavailable; restore it or create a new session');
  return {id,profile:selected.profile};
}

/** A resumed selection stays pinned while non-sandbox turns leave browser tools dormant. */
export function assertBrowserProfileMode(id:string,spec:{mode:string;evaluation?:unknown;sessionFile?:string}):void {
  if(id!=="isolated" && (spec.evaluation || (spec.mode!=="pi-ask" && !spec.sessionFile))) {
    throw new Error("Persistent browser requires pi-ask mode");
  }
}
