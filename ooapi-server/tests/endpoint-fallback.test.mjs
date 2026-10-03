import assert from "node:assert/strict";
import http from "node:http";
import { chat } from "../src/services/upstream/openai-compat.js";
import { chat as anthropic } from "../src/services/upstream/anthropic-compat.js";
import { endpointCandidates } from "../src/services/upstream/endpoint-fallback.js";
import { withEndpointAudit } from "../src/services/endpoint-audit.js";
import { reasoningSelection } from "../src/services/model-capabilities.js";
import { PROTOCOLS } from "../src/services/gateway-protocols.js";
import { publicRunError } from "../src/services/upstream/public-error.js";

const seen = []; let handler, id = 41000;
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}"); seen.push({ path: req.url, body, headers: req.headers });
  handler(req, res, body);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const json = (res, body, status = 200) => { res.writeHead(status, {"content-type":"application/json"});res.end(JSON.stringify(body)); };
const reject = (res, status = 404, extra = {}) => json(res, {error:{message:"fixture route rejected",code:"fixture_route"},...extra},status);
const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 4 } };
const response = {object:"response",model:"deepseek-flash",status:"completed",output:[{type:"message",content:[{type:"output_text",text:"OK"}]}],usage};
const completedChat = { model:"deepseek-flash",choices:[{message:{content:"OK"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13} };
const frames = events => events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join("");
const args = (path = "/v1") => ({channel:{id:++id,type:"custom",base_url:base+path,api_key:"fixture-not-a-real-key",other:{allow_private_upstream:true}},model:"deepseek-flash",messages:[{role:"system",content:"system instructions"},{role:"user",content:"question"}],reasoningConfig:reasoningSelection("deepseek-flash","medium"),maxOutputTokens:128});
let checks=0;
async function test(name, run) { seen.length=0; await run(); checks++; console.log("  ok  endpoint "+name); }
try {
  assert.equal(endpointCandidates("https://example.com/api/v3").length,3);
  assert.equal(endpointCandidates("https://example.com/custom/responses")[0].url,"https://example.com/custom/responses");
  await test("Responses 并行工具历史转换后满足上游消息顺序，正文与跨轮结果完整保留",async()=>{
    const input=[
      {role:'system',content:'system instructions'}, {role:'user',content:'review both files'},
      {role:'assistant',content:[{type:'output_text',text:'Read both.'}]},
      {type:'function_call',call_id:'a',name:'read',arguments:'{"file":"a"}'},
      {type:'reasoning',summary:[{type:'summary_text',text:'provider summary'}]},
      {type:'function_call',call_id:'b',name:'read',arguments:'{"file":"b"}'},
      {role:'assistant',content:[{type:'output_text',text:'Then compare.'}]},
      {type:'function_call_output',call_id:'b',output:'result B'},
      {type:'function_call_output',call_id:'a',output:'result A'},
      {role:'assistant',content:'Next round.'},
      {type:'function_call',call_id:'c',name:'read',arguments:'{"file":"c"}'},
      {type:'function_call_output',call_id:'c',output:'result C'},
      {role:'user',content:'continue the review'},
    ];
    const original=JSON.stringify(input);
    const parsed=PROTOCOLS.responses.parse({model:'deepseek-flash',input,max_output_tokens:384000,tools:[{type:'function',name:'read',parameters:{type:'object',properties:{file:{type:'string'}}}}]});
    handler=(_req,res,body)=>{
      const pending=new Set();
      for(const message of body.messages){
        if(message.role==='tool') { assert.ok(pending.delete(message.tool_call_id),'tool result must match the current assistant turn'); }
        else { assert.equal(pending.size,0,'no assistant or user may interrupt unanswered tool calls');for(const c of message.tool_calls||[])pending.add(c.id); }
      }
      assert.equal(pending.size,0);
      assert.deepEqual(body.messages.filter(m=>m.tool_calls).map(m=>[m.content,m.tool_calls.map(c=>c.id)]),[['Read both.Then compare.',['a','b']],['Next round.',['c']]]);
      assert.deepEqual(body.messages.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m.content]),[['b','result B'],['a','result A'],['c','result C']]);
      assert.equal(body.messages[2].tool_calls[0].function.arguments,'{"file":"a"}');
      assert.equal(body.max_tokens,384000);assert.equal(body.reasoning_effort,'max');
      json(res,completedChat);
    };
    const a={...args('/v2'),messages:parsed.messages,tools:parsed.tools,maxOutputTokens:parsed.maxTokens};
    assert.equal((await chat(a)).content,'OK');assert.equal(seen.length,1);assert.equal(JSON.stringify(input),original);
  });
  await test("WorkBuddy msg 参数拒绝不混入原始响应，也不误报模型不可用",async()=>{
    handler=(_req,res)=>json(res,{code:11133,msg:'Invalid request parameters',extError:{code:'model_param_invalid',message:'the request parameters were rejected by the model provider'},private:'fixture-private-response'},400);
    await assert.rejects(chat(args('/v2')),e=>{
      assert.equal(e.upstreamErrorCode,'11133');assert.equal(e.message,'上游返回 HTTP 400：Invalid request parameters');
      assert.match(publicRunError(e),/请求参数或工具调用历史/);assert.doesNotMatch(publicRunError(e),/模型不可用|fixture-private|model_param/);return true;
    });
    assert.equal(seen.length,3);
    assert.match(publicRunError({code:'CHANNEL_BAD_REQUEST',status:400,message:'{"extError":{"code":"model_param_invalid"}}'}),/请求参数或工具调用历史/);
    for(const message of ['model not found','model example is invalid','unsupported model','模型不存在'])assert.match(publicRunError({code:'CHANNEL_BAD_REQUEST',status:400,message}),/模型不可用/);
  });
  await test("v1 路径回退保留前缀，成功后复用路径",async()=>{
    handler=(req,res)=>req.url==="/prefix/chat/completions"?json(res,completedChat):reject(res);
    const a=args('/prefix/v1');assert.equal((await chat(a)).content,'OK');assert.deepEqual(seen.map(x=>x.path),['/prefix/v1/chat/completions','/prefix/chat/completions']);
    seen.length=0;assert.equal((await chat(a)).content,'OK');assert.equal(seen.length,1);assert.equal(seen[0].path,'/prefix/chat/completions');
  });
  await test("chat 拒绝后转换 Responses 的消息、工具、图片及流式返回",async()=>{
    handler=(req,res)=>{if(req.url!=='/v1/responses')return reject(res,400);res.writeHead(200,{'content-type':'text/event-stream'});res.end(frames([{type:'response.output_text.delta',delta:'OK'},{type:'response.completed',response}]));};
    const a=args();a.tools=[{name:'lookup',description:'lookup',parameters:{type:'object',properties:{}}}];a.toolChoice={name:'lookup'};
    a.messages.splice(1,0,{role:'assistant',content:'',tool_calls:[{id:'call-1',name:'lookup',arguments:'{}'}]},{role:'tool',tool_call_id:'call-1',content:'result'});
    a.images=[{mimeType:'image/png',buffer:Buffer.from('fixture')}];let emitted='';a.onDelta=t=>emitted+=t;
    const audit={endpoints:[],closed:false};const r=await withEndpointAudit(audit,()=>chat(a));assert.equal(r.content,'OK');assert.equal(emitted,'OK');assert.equal(r.retryCount,2);
    assert.deepEqual(r.usage,{prompt_tokens:10,completion_tokens:3,cached_tokens:4,total_tokens:13});
    const body=seen.at(-1).body;assert.equal(body.reasoning.effort,'max');assert.equal(body.max_output_tokens,128);assert.equal(body.instructions,'system instructions');assert.equal(body.tools[0].name,'lookup');
    assert.ok(body.input.some(i=>i.type==='function_call_output'&&i.call_id==='call-1'));assert.ok(body.input.some(i=>i.role==='user'&&i.content.some(p=>p.type==='input_image')));
    assert.deepEqual(audit.attempts.map(x=>x.status),[400,400,200]);assert.ok(seen.every(x=>x.headers.authorization==='Bearer fixture-not-a-real-key'));
  });
  await test("Responses 全快照工具参数不重复",async()=>{
    const item={id:'fc-1',type:'function_call',call_id:'call-1',name:'lookup',arguments:'{"q":1}'};
    handler=(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(frames([{type:'response.output_item.added',output_index:0,item:{...item,arguments:''}},{type:'response.function_call_arguments.delta',item_id:'fc-1',delta:item.arguments},{type:'response.completed',response:{...response,output:[item]}}]));};
    const r=await chat(args('/responses'));assert.equal(r.toolCalls.length,1);assert.equal(r.toolCalls[0].arguments,item.arguments);assert.equal(r.toolCalls[0].id,'call-1');
  });
  await test("三种协议遍历到 Messages，支持非流式 JSON 和工具上下文",async()=>{
    handler=(req,res)=>req.url==='/messages'?json(res,{type:'message',model:'deepseek-flash',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:3}}):reject(res);
    const a=args();a.messages.splice(1,0,{role:'assistant',content:'',tool_calls:[{id:'call-1',name:'lookup',arguments:'{}'}]},{role:'tool',tool_call_id:'call-1',content:'result'});
    const r=await chat(a);assert.equal(r.content,'OK');assert.equal(seen.length,6);const last=seen.at(-1);assert.equal(last.headers['x-api-key'],'fixture-not-a-real-key');assert.ok(last.body.messages.some(m=>m.content.some(b=>b.type==='tool_result'&&b.tool_use_id==='call-1')));assert.equal(last.body.max_tokens,128);
  });
  await test("Anthropic 接入反向回退到 Chat Completions",async()=>{
    handler=(req,res)=>req.url==='/v1/chat/completions'?json(res,completedChat):reject(res);
    assert.equal((await anthropic(args())).content,'OK');assert.equal(seen.length,3);
  });
  await test("全部失败才抛错且保留第一条有用拒绝",async()=>{
    handler=(req,res)=>reject(res,req.url==='/v1/chat/completions'?400:404);
    await assert.rejects(chat(args()),e=>e.status===400&&e.retryCount===5);assert.equal(seen.length,6);
  });
  for(const status of [401,403,429])await test(`HTTP${status} 不改端点绕过鉴权/限流`,async()=>{
    handler=(_req,res)=>reject(res,status);await assert.rejects(chat(args()));assert.equal(seen.length,1);
  });
  await test("已产生用量的拒绝不能重发",async()=>{
    handler=(_req,res)=>reject(res,400,{usage:{prompt_tokens:10,completion_tokens:0,total_tokens:10}});
    await assert.rejects(chat(args()),e=>e.billable===true);assert.equal(seen.length,1);
  });
  await test("Responses 拒绝含用量时保留真实计费明细且不重发",async()=>{
    handler=(_req,res)=>reject(res,400,{usage});
    await assert.rejects(chat(args('/responses')),e=>e.billable===true&&e.usage.prompt_tokens===10&&e.usage.cached_tokens===4);assert.equal(seen.length,1);
  });
  await test("已经输出后流中断不能换协议",async()=>{
    handler=(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(frames([{choices:[{delta:{content:'part'}}]}]));};
    await assert.rejects(chat(args()),e=>e.billable===true);assert.equal(seen.length,1);
  });
  await test("缺省推理关闭；取消不能再发请求",async()=>{
    handler=(_req,res)=>json(res,completedChat);const a=args();a.reasoningConfig=reasoningSelection('deepseek-flash','');await chat(a);assert.deepEqual(seen[0].body.thinking,{type:'disabled'});assert.ok(!('reasoning_effort'in seen[0].body));
    seen.length=0;await assert.rejects(chat({...args(),signal:AbortSignal.abort()}),e=>e.code==='CHANNEL_ABORTED');assert.equal(seen.length,0);
  });
  console.log(`Endpoint adaptation: ${checks} HTTP cases passed`);
} finally { server.closeAllConnections();await new Promise(r=>server.close(r)); }
