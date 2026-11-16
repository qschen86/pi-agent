import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

type Coding='identity'|'br'|'gzip';
type Representation={body:Uint8Array;digest:string};
type Representations=Partial<Record<Coding,Representation>>;
export class StaticEncodings {
 private manifest:Record<string,any>={};
 private cache=new Map<string,Representation>();
 constructor(private dir:string,enabled:boolean){
  if(!enabled)return;
  try{const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));if(m.schema===1&&m.assets)this.manifest=m.assets;}catch{}
 }
 get(digest:string,identity:Uint8Array):Representations{
  const result:Representations={identity:{body:identity,digest}},entry=this.manifest[digest];
  for(const coding of ['br','gzip'] as const){
   const meta=entry?.[coding];if(!meta||!Number.isSafeInteger(meta.bytes)||meta.bytes>=identity.byteLength||!/^[a-f0-9]{64}$/.test(meta.digest))continue;
   const key=digest+':'+coding;let representation=this.cache.get(key);
   if(!representation)try{
    const body=readFileSync(join(this.dir,digest+(coding==='br'?'.br':'.gz')));
    if(body.byteLength!==meta.bytes||createHash('sha256').update(body).digest('hex')!==meta.digest)continue;
    representation={body,digest:meta.digest};this.cache.set(key,representation);
   }catch{continue;}
   result[coding]=representation;
  }
  return result;
 }
}

/** RFC 9110 section 12.5.3. Missing/empty headers use identity; explicit exclusions apply. */
export function selectEncoding(header:string|undefined,available:Representations):Coding|null{
 if(!header?.trim())return 'identity';
 const qualities=new Map<string,number>();
 for(const part of header.toLowerCase().split(',')){
  const [token,...params]=part.trim().split(';');if(!token)continue;
  const qParam=params.map(p=>p.trim()).find(p=>p.startsWith('q='));
  const q=qParam?( /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qParam)?Number(qParam.slice(2)):0):1;
  qualities.set(token,Math.max(qualities.get(token)??0,q));
 }
 const wildcard=qualities.get('*'),identity=qualities.get('identity')??(wildcard===0?0:1);
 const encoded=(['br','gzip'] as const).filter(c=>available[c]&&(qualities.get(c)??wildcard??0)>0)
  .sort((a,b)=>(qualities.get(b)??wildcard??0)-(qualities.get(a)??wildcard??0));
 const best=encoded[0];
 if(best&&(!qualities.has('identity')||identity<=(qualities.get(best)??wildcard??0)))return best;
 return identity>0?'identity':best??null;
}
