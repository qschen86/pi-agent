/** Public metadata and control SDK. Operator state paths never cross this protocol. */
export interface PermissionGrant { id:string;tool:string;action:string;scope:string;grantedAt:string|null }
export interface PermissionGrantList { version:1;revision:number;grants:PermissionGrant[] }
export function parsePermissionGrantList(value:unknown):PermissionGrantList {
  const v=value as PermissionGrantList;
  if(!v||v.version!==1||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.grants)||v.grants.length>1000)throw new Error('Invalid runtime permission list');
  const ids=new Set<string>();
  for(const g of v.grants){
    if(!g||typeof g.id!=='string'||!/^[a-f0-9]{64}$/.test(g.id)||ids.has(g.id)||typeof g.tool!=='string'||g.tool.length>160||typeof g.action!=='string'||g.action.length>1000||typeof g.scope!=='string'||g.scope.length>4096||!(g.grantedAt===null||typeof g.grantedAt==='string'&&Number.isFinite(Date.parse(g.grantedAt)))||Object.keys(g).some(k=>!['id','tool','action','scope','grantedAt'].includes(k)))throw new Error('Invalid runtime permission metadata');
    ids.add(g.id);
  }
  return {version:1,revision:v.revision,grants:v.grants};
}
export async function controlPermissionGrants(run:(args:string[])=>Promise<string>,sessionFile:string,workspace:string,revoke?:{id?:string}):Promise<PermissionGrantList>{
  const describe=JSON.parse(await run(['--describe']));
  if(describe.permissionGrantControl!==1)throw new Error('Pi runtime 不支持授权管理，请更新 runtime');
  if(revoke?.id!==undefined&&!/^[a-f0-9]{64}$/.test(revoke.id))throw new Error('Invalid runtime grant ID');
  return parsePermissionGrantList(JSON.parse(await run(['--permission-grants','--session',sessionFile,'--cwd',workspace,...(revoke?revoke.id?['--revoke-grant',revoke.id]:['--revoke-all-grants']:[])])));
}
