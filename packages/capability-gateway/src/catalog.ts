import type {Capability,Provider,Risk} from './contracts.js';
const str={type:'string',minLength:1,maxLength:10000};
function capability(provider:Provider,resource:string,action:string,title:string,risk:Risk='read',properties:Record<string,unknown>={},required:string[]=[]):Capability{
 return {id:`${provider}.${resource}.${action}`,provider,title,risk,resourceKind:provider==='github'?'repo':resource==='zone'||resource==='dns'?'zone':'account',timeoutMs:20000,inputSchema:{type:'object',additionalProperties:false,properties,required}};
}
export const CATALOG:Capability[]=[
 capability('github','repo','read','读取仓库'),capability('github','pr','read','读取拉取请求'),
 capability('github','issue','read','读取议题'),capability('github','workflow','read','读取工作流运行'),capability('github','release','read','读取发布'),
 capability('github','pr','create','创建拉取请求','write',{title:str,head:str,base:str,body:str,draft:{type:'boolean'}},['title','head','base']),
 capability('github','release','create','创建发布','write',{tag_name:str,name:str,body:str,draft:{type:'boolean'},prerelease:{type:'boolean'}},['tag_name']),
 capability('cloudflare','zone','read','读取域名区域'),capability('cloudflare','dns','read','读取 DNS 记录'),
 capability('cloudflare','workers','read','读取 Workers'),capability('cloudflare','pages','read','读取 Pages 项目'),
 capability('cloudflare','deployment','read','读取 Pages 部署','read',{project:{type:'string',pattern:'^[a-z0-9-]{1,58}$'}},['project']),
 capability('cloudflare','dns','update','修改 DNS 记录','write',{recordId:{type:'string',pattern:'^[a-f0-9]{32}$'},type:{type:'string',enum:['A','AAAA','CNAME','TXT','MX','NS','SRV','CAA']},name:{...str,maxLength:253},content:{...str,maxLength:4096},ttl:{type:'integer',minimum:1,maximum:86400},proxied:{type:'boolean'},priority:{type:'integer',minimum:0,maximum:65535}},['recordId','type','name','content']),
 capability('cloudflare','deployment','create','部署 Pages 已连接仓库的最新提交','write',{project:{type:'string',pattern:'^[a-z0-9-]{1,58}$'},branch:{type:'string',pattern:'^[A-Za-z0-9_./-]{1,200}$'}},['project','branch'])
];
// No generic execute, arbitrary URL, shell, Code Mode, or third-party MCP dispatch.
export const CONNECTORS=[{id:'github',name:'GitHub',installed:true,transport:'rest'},{id:'cloudflare',name:'Cloudflare',installed:true,transport:'rest'}] as const;
