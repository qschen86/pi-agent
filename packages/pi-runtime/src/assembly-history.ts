/** Operator-only assembly archive: adding tools never silently upgrades native history. */
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {loadPiCommunityProfile} from './pi-community-profile.js';
export function selectHistoricalProfile(input:{profile?:string;sessionFile?:string;catalogFile:string;workspace:string}):string|undefined {
  if(!input.profile||!input.sessionFile)return input.profile;
  const rows=readFileSync(input.sessionFile,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s));
  const expected=rows.reverse().find(r=>r.type==='custom'&&r.customType==='pi-runtime-assembly')?.data?.fingerprint;
  if(!expected||expected==='legacy'||loadPiCommunityProfile(input.profile,input.workspace).fingerprint===expected)return input.profile;
  if(!existsSync(input.catalogFile))return input.profile; // Existing supervisor fallback still checks identity.
  const stat=lstatSync(input.catalogFile);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.()||stat.size>65536)throw new Error('Unsafe historical assembly catalog');
  const raw=JSON.parse(readFileSync(input.catalogFile,'utf8'));
  if(raw?.version!==1||!Array.isArray(raw.profiles)||raw.profiles.length>32||Object.keys(raw).some(k=>!['version','profiles'].includes(k)))throw new Error('Invalid historical assembly catalog');
  for(const entry of raw.profiles){
    if(!entry||typeof entry.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(entry.fingerprint)||typeof entry.profile!=='string'||!isAbsolute(entry.profile)||Object.keys(entry).some(k=>!['fingerprint','profile'].includes(k)))throw new Error('Invalid historical assembly entry');
    if(entry.fingerprint!==expected)continue;
    const st=lstatSync(entry.profile);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o022)||st.uid!==process.getuid?.()||st.size>65536)throw new Error('Unsafe historical assembly profile');
    if(loadPiCommunityProfile(entry.profile,input.workspace).fingerprint!==expected)throw new Error('Historical assembly changed; restore its operator configuration');
    return entry.profile;
  }
  return input.profile;
}
