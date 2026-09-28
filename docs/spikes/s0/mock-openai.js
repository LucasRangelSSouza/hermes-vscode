// Minimal OpenAI-compatible mock. Logs auth header + request summary to mock.log
const http=require('http'),fs=require('fs');
const log=(o)=>fs.appendFileSync(__dirname+'/mock.log',JSON.stringify(o)+'\n');
const sse=(res,obj)=>res.write('data: '+JSON.stringify(obj)+'\n\n');
http.createServer((req,res)=>{
  let b='';req.on('data',d=>b+=d).on('end',()=>{
    const auth=req.headers['authorization']||null;
    if(req.url.endsWith('/models')){log({url:req.url,auth});res.setHeader('content-type','application/json');return res.end(JSON.stringify({object:'list',data:[{id:'mock-model',object:'model'}]}));}
    if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
    const j=JSON.parse(b||'{}');const msgs=j.messages||[];const last=msgs[msgs.length-1]||{};
    const tools=(j.tools||[]).map(t=>t.function&&t.function.name);
    log({url:req.url,auth,stream:j.stream,model:j.model,nmsgs:msgs.length,lastRole:last.role,ntools:tools.length,hasTerminal:tools.includes('terminal')});
    const id='chatcmpl-'+Date.now(),base={id,object:'chat.completion.chunk',created:0,model:j.model||'mock-model'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    const userText=JSON.stringify(msgs.filter(m=>m.role==='user').pop()||'');
    if(last.role==='tool'){
      const t=typeof last.content==='string'?last.content:JSON.stringify(last.content);
      sse(res,{...base,choices:[{index:0,delta:{role:'assistant',content:'TOOL_RESULT_SEEN: '+t.slice(0,300)},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'stop'}]});
    } else if(userText.includes('RUNTOOL')&&tools.includes('terminal')){
      sse(res,{...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'terminal',arguments:JSON.stringify({command:'echo hello-from-bash && bash --version | head -1'})}}]},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});
    } else {
      for(const w of ['Hello ','from ','the ','mock.']) sse(res,{...base,choices:[{index:0,delta:{role:'assistant',content:w},finish_reason:null}]});
      sse(res,{...base,choices:[{index:0,delta:{},finish_reason:'stop'}]});
    }
    res.write('data: [DONE]\n\n');res.end();
  });
}).listen(8899,'127.0.0.1',()=>console.log('mock on 8899'));
