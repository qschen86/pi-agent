import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { communityApproval, CommunitySessionGrants } from '../src/community-approval.js';

const event = {type:'extension_ui_request',method:'select',title:'Permission Required\ntool : read\npath : /skills/a.md',options:['Yes','Yes, allow reads to "/skills/*" for this session','Yes, allow reads and writes to "/skills/*" for this session','No','No, provide reason']};
it('recognizes the pinned permission dialog and selects the narrow session option, preserving normal questions',()=>{
  expect(communityApproval(event)).toMatchObject({tool:'read',session:event.options[1],action:'tool : read\npath : /skills/a.md'});
  expect(communityApproval({...event,title:'请选择颜色'})).toBeUndefined();
  expect(communityApproval({...event,options:['Yes','No']})).toBeUndefined();
  expect(communityApproval({...event,title:'Permission Required (Subagent)\nApply this session grant to:'})).toBeUndefined();
});
it('retains only an exact request across runtime restarts, bound to session/workspace/assembly',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-grants-'));
  try {
    const file=join(root,'grants.json'),key=communityApproval(event)!.key;
    const grants=new CommunitySessionGrants(file,'session/workspace/assembly');
    expect(grants.has(key)).toBe(false);grants.add(key);
    const resumed=new CommunitySessionGrants(file,'session/workspace/assembly');
    expect(resumed.has(key)).toBe(true);
    expect(resumed.has(communityApproval({...event,title:event.title+'-different-file'})!.key)).toBe(false);
    expect(()=>new CommunitySessionGrants(file,'different-session')).toThrow(/Invalid/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

it('lists runtime grants and observes single/all revocation in already running supervisors',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-grants-revoke-'));
  try {
    const file=join(root,'grants.json'),a='a'.repeat(64),b='b'.repeat(64);
    const running=new CommunitySessionGrants(file,'identity');
    running.add(a,{tool:'read',action:'read /fixture/a',scope:'/fixture'});
    running.add(b,{tool:'write',action:'write /fixture/b',scope:'/fixture'});
    const control=new CommunitySessionGrants(file,'identity');
    expect(control.list().grants).toMatchObject([{id:a,tool:'read',action:'read /fixture/a'},{id:b,tool:'write'}]);
    control.revoke(a);
    expect(running.has(a)).toBe(false); expect(running.has(b)).toBe(true);
    control.revoke();
    expect(running.has(b)).toBe(false); expect(control.list().grants).toEqual([]);
    running.add(a,{tool:'read',action:'new approval',scope:'/fixture'},running.list().revision);
    expect(control.has(a)).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
it('never resurrects revoked grants from a stale pending approval or another writer cache',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-grants-race-'));
  try {
    const file=join(root,'grants.json'),a='a'.repeat(64),b='b'.repeat(64);
    const first=new CommunitySessionGrants(file,'identity'),second=new CommunitySessionGrants(file,'identity');
    const revision=first.list().revision;
    first.add(a);second.add(b);
    expect(first.list().grants.map(g=>g.id)).toEqual([a,b]);
    second.revoke(a);
    expect(first.add(a,undefined,revision)).toBe(false);
    expect(first.has(a)).toBe(false);expect(first.has(b)).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
