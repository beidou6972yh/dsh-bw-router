#!/usr/bin/env node
// Thin CLI for non-MCP clients: wb-max plan ... / wb-max exec ...
import { readFileSync } from 'node:fs';
const BASE = (process.env.WB_GATEWAY_URL || 'http://127.0.0.1:18790').replace(/\/+$/, '');
const KEY_FILE = process.env.WB_GATEWAY_KEY_FILE || '/opt/wb-router/config/wb-remote.json';
function key(){const e=(process.env.WB_GATEWAY_API_KEY||'').trim();if(e)return e;try{return String(JSON.parse(readFileSync(KEY_FILE,'utf8')).token||'').trim()}catch{return ''}}
async function api(path, method='GET', body){const h={accept:'application/json'};const k=key();if(k)h.authorization=`Bearer ${k}`;if(body!==undefined)h['content-type']='application/json';const r=await fetch(BASE+path,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});const t=await r.text();let d;try{d=JSON.parse(t)}catch{d={ok:false,error:t.slice(0,500)}};return{status:r.status,ok:r.ok,data:d}}
function arg(name, def=''){const i=process.argv.indexOf('--'+name);return i>=0?process.argv[i+1]:def}
const cmd=process.argv[2]||'help';
if(cmd==='help'||cmd==='--help'){
  console.log(`wb-max <plan|exec|health|doctor>
plan --task "..." [--strategy auto|cost|capability|function] [--function coding] [--context "..."] [--max-stages 3]
exec --plan-id ... --stage-id ... --model upstream/model --prompt "..." [--strategy ...] [--capability ...] [--function ...]
health
doctor`);
  process.exit(0);
}
if(cmd==='health'){const r=await api('/health');console.log(JSON.stringify({status:r.status,ok:r.status===200,gateway:r.data},null,2));process.exit(r.status===200?0:1)}
if(cmd==='doctor'){
  // Q2-4（2026-11-18）：一条命令自检「我该不该连、连哪个」——不打印任何密钥。
  const envKey=(process.env.WB_GATEWAY_API_KEY||'').trim();
  let fileKey='';try{fileKey=String(JSON.parse(readFileSync(KEY_FILE,'utf8')).token||'').trim()}catch{}
  const out={base:BASE,key:{source:envKey?'env(wb)':'file',file:KEY_FILE,present:!!(envKey||fileKey)},
    health:{reachable:false,status:null,error:null},hint:''};
  try{
    const r=await fetch(BASE+'/health',{signal:AbortSignal.timeout(4000)});
    out.health.status=r.status;out.health.reachable=r.status===200;
    if(!r.ok)out.health.error='HTTP '+r.status;
  }catch(e){out.health.error=String(e&&e.message||e)}
  if(!out.key.present)out.hint='缺少 key：设 WB_GATEWAY_API_KEY 或把 {"token":"..."} 写入 '+KEY_FILE;
  else if(!out.health.reachable)out.hint='网关不可达（本机默认只绑 127.0.0.1:18790；外部用 https://gateway.example.com）';
  else out.hint='ok';
  console.log(JSON.stringify(out,null,2));process.exit(out.health.reachable?0:2);
}
if(cmd==='plan'){
  const body={task:arg('task'),strategy:arg('strategy','auto'),constraints:{max_stages:Number(arg('max-stages','3'))}};
  const context=arg('context');if(context)body.context=context;const fn=arg('function');if(fn)body.function=fn;
  if(arg('ignore-learned-override')==='true')body.ignore_learned_override=true;
  const r=await api('/v1/route/plan','POST',body);console.log(JSON.stringify({status:r.status,...r.data},null,2));process.exit(r.ok?0:1);
}
if(cmd==='exec'){
  if(arg('confirmed')!=='true'){console.error('必须 --confirmed true（用户已确认）');process.exit(2)}
  const messages=arg('messages')?JSON.parse(arg('messages')):[{role:'user',content:arg('prompt')}];
  const body={model:arg('model'),messages,stream:false};const temp=arg('temperature');if(temp)body.temperature=Number(temp);const mt=arg('max-tokens');if(mt)body.max_tokens=Number(mt);
  const r=await api('/v1/chat/completions','POST',body);if(!r.ok){console.error(JSON.stringify(r.data));process.exit(1)}
  const ann=await api('/v1/route/annotation','POST',{plan_id:arg('plan-id'),stage_id:arg('stage-id'),model_key:arg('model'),confirmed:true,outcome:'ok',strategy:arg('strategy')||undefined,capability:arg('capability')||undefined,function:arg('function')||undefined,usage:r.data?.usage||{}});
  console.log(JSON.stringify({ok:true,model:arg('model'),usage:r.data?.usage||{},content:r.data?.choices?.[0]?.message?.content||'',annotation:{status:ann.status,ok:ann.ok,learned:ann.data?.learned||null}},null,2));process.exit(0);
}
console.error('unknown command');process.exit(2);
