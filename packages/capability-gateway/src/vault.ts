/** Host-only file vault. 0600 is access control between OS users, not a sandbox for same-user shells. */
import {mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,lstatSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GatewayError} from './contracts.js';
export class FileVault {
 constructor(private root:string){mkdirSync(root,{recursive:true,mode:0o700});if(lstatSync(root).isSymbolicLink())throw new GatewayError('VAULT_UNSAFE');chmodSync(root,0o700);}
 private path(ref:string){if(!/^[a-f0-9-]{36}$/.test(ref))throw new GatewayError('INVALID_CREDENTIAL_REF');return join(this.root,ref+'.json');}
 put(token:string){if(typeof token!=='string'||token.length<10||token.length>4096||/\s/.test(token))throw new GatewayError('INVALID_TOKEN');const ref=randomUUID(),file=this.path(ref),tmp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify({token}),{mode:0o600,flag:'wx'});renameSync(tmp,file);}finally{rmSync(tmp,{force:true});}return ref;}
 read(ref:string):string{const file=this.path(ref),s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw new GatewayError('VAULT_UNSAFE');return JSON.parse(readFileSync(file,'utf8')).token;}
 remove(ref:string){rmSync(this.path(ref),{force:true});}
}
