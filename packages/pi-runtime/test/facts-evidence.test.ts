import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectEvidence} from '../src/facts/collectors.js';
import {loadEvidencePolicy,type EvidencePolicy} from '../src/facts/evidence-policy.js';
it('collects only allowlisted typed fields and rejects forged or sensitive requests',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fact-evidence-'));
 try{const file=join(root,'config.json');writeFileSync(file,JSON.stringify({enabled:false,apiKey:'secret-canary'}),{mode:0o600});
 const policy:EvidencePolicy={version:1,enabled:true,sources:[{id:'config',collectorId:'json',subjectId:'web',file,root,pointer:'/enabled',fact:{schemaVersion:1,scope:{project:'a',environment:'local',instance:'mac',target:'memory',qualifiers:{layer:'desired',pointer:'/enabled'}},subject:'web',predicate:'config.value'}}]};
 const r=await collectEvidence({collectorId:'json',subjectId:'web'},policy);expect(r.value).toBe(false);expect(JSON.stringify(r)).not.toContain('secret-canary');expect(r).not.toHaveProperty('apiKey');
 await expect(collectEvidence({collectorId:'json',subjectId:'unknown'},policy)).rejects.toThrow('unknown-collector');
 await expect(collectEvidence({collectorId:'json',subjectId:'web'},{...policy,sources:[{...policy.sources[0]!,pointer:'/apiKey'}]})).rejects.toThrow('sensitive');
 const link=join(root,'link');symlinkSync(file,link);await expect(collectEvidence({collectorId:'json',subjectId:'web'},{...policy,sources:[{...policy.sources[0]!,file:link}]})).rejects.toThrow('symlink');
 const p=join(root,'policy.json');writeFileSync(p,JSON.stringify(policy),{mode:0o600});expect(loadEvidencePolicy(p).enabled).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('does not turn arbitrary successful HTTP responses or redirects into serving identity',async()=>{
 const policy:EvidencePolicy={version:1,enabled:true,sources:[{id:'serving',collectorId:'serving',subjectId:'web',url:'https://example.invalid/__deployment',fact:{schemaVersion:1,scope:{project:'a',environment:'production',instance:'blue',target:'memory',qualifiers:{slot:'blue'}},subject:'web',predicate:'deployment.serving_revision'}}]};
 await expect(collectEvidence({collectorId:'serving',subjectId:'web'},policy,async()=>new Response('{}'))).rejects.toThrow();
 await expect(collectEvidence({collectorId:'serving',subjectId:'web'},policy,async()=>new Response('',{status:302}))).rejects.toThrow();
});
