// Minimal ACP client: node acp-client.js "<prompt>" ; env HERMES_HOME, OPENAI_API_KEY passed through
const {spawn}=require('child_process'),path=require('path');
const exe=process.env.HERMES_ACP_EXE;const cwd=process.env.ACP_CWD||process.cwd();
const p=spawn(exe,[],{stdio:['pipe','pipe','pipe'],env:process.env,windowsHide:true,cwd});
let id=1,pending=new Map(),buf='',out={chunks:[],tools:[],perm:[],updates:new Set()};
const send=(o)=>p.stdin.write(JSON.stringify(o)+'\n');
const call=(m,params)=>new Promise((res,rej)=>{const i=id++;pending.set(i,{res,rej});send({jsonrpc:'2.0',id:i,method:m,params});});
p.stderr.on('data',d=>{if(process.env.SHOW_STDERR)process.stderr.write(d)});
p.stdout.on('data',d=>{buf+=d;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n).trim();buf=buf.slice(n+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{console.log('NONJSON',line.slice(0,120));continue}
  if(m.id!==undefined&&(m.result!==undefined||m.error)&&pending.has(m.id)){const q=pending.get(m.id);pending.delete(m.id);m.error?q.rej(new Error(JSON.stringify(m.error))):q.res(m.result);}
  else if(m.method==='session/update'){const u=m.params.update||{};out.updates.add(u.sessionUpdate);if(u.sessionUpdate==='agent_message_chunk')out.chunks.push(u.content&&u.content.text);if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update')out.tools.push({t:u.sessionUpdate,title:u.title,status:u.status,kind:u.kind});}
  else if(m.method==='session/request_permission'){out.perm.push(m.params);const opts=(m.params.options||[]);const o=opts.find(x=>/allow_once/.test(x.kind||x.optionId))||opts[0];send({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'selected',optionId:o&&o.optionId}}});}
}});
(async()=>{try{
  const init=await call('initialize',{protocolVersion:1});
  console.log('INIT ok, agent:',JSON.stringify(init.agentInfo||{}),'authMethods:',(init.authMethods||[]).map(a=>a.id).join(','));
  const s=await call('session/new',{cwd,mcpServers:[]});
  console.log('SESSION',s.sessionId,'model:',s.models&&s.models.currentModelId);
  const r=await call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:process.argv[2]||'hi'}]});
  console.log('STOP',JSON.stringify(r));
  console.log('TEXT:',out.chunks.join(''));console.log('UPDATES:',[...out.updates].join(','));
  console.log('TOOLS:',JSON.stringify(out.tools));console.log('PERMS:',out.perm.length,JSON.stringify(out.perm[0]||{}).slice(0,300));
}catch(e){console.log('ERR',e.message)}finally{p.kill();setTimeout(()=>process.exit(0),300)}})();
setTimeout(()=>{console.log('TIMEOUT');p.kill();process.exit(2)},170000);
