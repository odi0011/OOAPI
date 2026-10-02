// 真实适配器 + 受控传输：工具增量、纯工具回复、终止事件和结果回传。
// 不访问生产凭据/公网/数据库；缺失的传输请求立即失败。
import test from "node:test";
import assert from "node:assert/strict";
import { chat as openai } from "../src/services/upstream/openai-compat.js";
import { chat as anthropic } from "../src/services/upstream/anthropic-compat.js";
import { chat as claude } from "../src/services/upstream/claude-oauth.js";
import { chat as codex } from "../src/services/upstream/codex.js";
import { chat as grok } from "../src/services/upstream/grok.js";
import { chat as gemini } from "../src/services/upstream/antigravity.js";
import { chat as kiro, buildBody } from "../src/services/upstream/kiro.js";
import { chatNative } from "../src/services/upstream/opencode-native.js";
import { ToolCallBuffer, chatCalls, textToolMessages } from "../src/services/tool-wire.js";
import { nativeToolSpecs } from "../src/services/harness/tools.js";
import { buildSystemPrompt } from "../src/services/harness/agents.js";
import { PROTOCOLS } from "../src/services/gateway-protocols.js";

const definitions = nativeToolSpecs(["account"]);
const tool = { id: "call_fixture", name: "account", arguments: '{"action":"overview"}' };
const messages = [{ role: "system", content: "SYSTEM_FIXTURE" }, { role: "user", content: "查余额" }];
const history = [...messages, { role: "assistant", content: "", tool_calls: chatCalls([tool]) }, { role: "tool", tool_call_id: tool.id, name: "account", content: "REAL_FIXTURE_BALANCE", is_error: false }];
const channel = () => ({ id: 889901, api_key: "fixture", base_url: "http://127.0.0.1:1/v1", other: { method: "api", allow_private_upstream: true, access_token: "fixture", expires_at: Math.floor(Date.now()/1000)+3600, project_id: "fixture", region: "us-east-1" } });
const sse = (events) => new Response(events.map(ev=>`data: ${JSON.stringify(ev)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
async function captured(fn, response, check) {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (url, init) => { count++; check?.(JSON.parse(init.body), url); return response(); };
  try { const r = await fn(); assert.equal(count,1); return r; }
  finally { globalThis.fetch = original; }
}
const chatEvents = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: tool.id, function: { name: tool.name, arguments: '{"action":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"overview"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 25, completion_tokens: 8 } },
];
const responseEvents = [
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_fixture", call_id: tool.id, name: tool.name, arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_fixture", delta: '{"action":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_fixture", delta: '"overview"}' },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_fixture", call_id: tool.id, name: tool.name, arguments: tool.arguments } },
  { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", id: "fc_fixture", call_id: tool.id, name: tool.name, arguments: tool.arguments }], usage: { input_tokens: 25, output_tokens: 8 } } },
];
const anthropicEvents = [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"action":' } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"overview"}' } },
  { type: "content_block_stop", index: 0 }, { type: "message_stop" },
];
test("Chat增量只调用一次、纯工具回复成功、结果编号与真实内容回传", async () => {
  let delta = 0;
  const r = await captured(()=>openai({ channel: channel(), model:"fixture", tools:definitions, messages, onToolCall:()=>delta++ }), ()=>sse(chatEvents), b=>assert.equal(b.tools[0].function.name,"account"));
  assert.deepEqual(r.toolCalls,[tool]); assert.equal(r.content,""); assert.equal(delta,2);
  await captured(()=>openai({ channel:channel(), model:"fixture", tools:definitions, messages:history }), ()=>sse(chatEvents), b=>{ assert.equal(b.messages.at(-1).tool_call_id,tool.id); assert.equal(b.messages.at(-1).content,"REAL_FIXTURE_BALANCE"); });
});
for (const [name, chat, events, check] of [
  ["Anthropic API",anthropic,anthropicEvents,b=>{ assert.equal(b.tools[0].input_schema.type,"object"); assert.equal(b.messages.at(-1).content[0].tool_use_id,tool.id); }],
  ["Claude OAuth",claude,anthropicEvents,b=>{ assert.equal(b.tools[0].name,"account"); assert.equal(b.messages.at(-1).content[0].content,"REAL_FIXTURE_BALANCE"); }],
  ["Codex Responses",codex,responseEvents,b=>{ assert.equal(b.tools[0].name,"account"); assert.equal(b.input.at(-1).type,"function_call_output"); assert.equal(b.input.at(-1).call_id,tool.id); }],
  ["Grok Responses",grok,responseEvents,b=>{ assert.equal(b.tools[0].name,"account"); assert.equal(b.input.at(-1).output,"REAL_FIXTURE_BALANCE"); }],
  ["OpenCode Responses",args=>chatNative(args,"responses","fixture"),responseEvents,b=>{ assert.equal(b.tools[0].name,"account"); assert.equal(b.input.at(-1).call_id,tool.id); }],
]) {
  test(`${name}完整工具往返与增量/done去重`,async()=>{
    const r=await captured(()=>chat({channel:channel(),model:"fixture",messages:history,tools:definitions}),()=>sse(events),check);
    assert.deepEqual(r.toolCalls,[tool]);
  });
  test(`${name}不执行提前断开的工具响应`,async()=>{
    await assert.rejects(()=>captured(()=>chat({channel:channel(),model:"fixture",messages,tools:definitions}),()=>sse(events.slice(0,3))),/未完成|提前结束|完成事件/);
  });
}
test("Gemini functionCall/Response及thoughtSignature保持",async()=>{
  const ev={response:{candidates:[{content:{parts:[{functionCall:{id:tool.id,name:tool.name,args:{action:"overview"}},thoughtSignature:"fixture-signature"}]},finishReason:"STOP"}]}};
  const r=await captured(()=>gemini({channel:channel(),model:"fixture",messages:history,tools:definitions}),()=>sse([ev]),b=>{
    assert.equal(b.request.tools[0].functionDeclarations[0].name,"account");
    assert.equal(b.request.contents.at(-1).parts[0].functionResponse.response.output,"REAL_FIXTURE_BALANCE");
  });
  assert.equal(r.toolCalls[0].thoughtSignature,"fixture-signature"); assert.equal(r.toolCalls[0].arguments,tool.arguments);
});
function awsFrame(type,payload) {
  const n=Buffer.from(":event-type"),v=Buffer.from(type),headers=Buffer.concat([Buffer.from([n.length]),n,Buffer.from([7,v.length>>8,v.length&255]),v]);
  const data=Buffer.from(JSON.stringify(payload)),pre=Buffer.alloc(12);pre.writeUInt32BE(16+headers.length+data.length,0);pre.writeUInt32BE(headers.length,4);
  return Buffer.concat([pre,headers,data,Buffer.alloc(4)]);
}
test("Kiro auto系统指令/工具定义/结果均保留，AWS工具增量组装",async()=>{
  const body=buildBody(channel(),"auto","",history,definitions,"fixture-session");
  const cur=body.conversationState.currentMessage.userInputMessage;
  assert.match(cur.content,/SYSTEM_FIXTURE/); assert.equal(cur.userInputMessageContext.tools[0].toolSpecification.name,"account");
  assert.equal(cur.userInputMessageContext.toolResults[0].toolUseId,tool.id);
  assert.equal(body.conversationState.history.at(-1).assistantResponseMessage.toolUses[0].name,"account");
  const frames=[awsFrame("toolUseEvent",{toolUseId:tool.id,name:tool.name,input:'{"action":'}),awsFrame("toolUseEvent",{toolUseId:tool.id,input:'"overview"}',stop:true})];
  const r=await captured(()=>kiro({channel:channel(),model:"auto",messages,tools:definitions}),()=>new Response(Buffer.concat(frames)));
  assert.deepEqual(r.toolCalls,[tool]);
  await assert.rejects(()=>captured(()=>kiro({channel:channel(),model:"auto",messages,tools:definitions}),()=>new Response(frames[0])),/未完成/);
});
test("思考签名与Responses reasoning按原协议回传，文本回退不泄露协议元信息",()=>{
  const buffer=new ToolCallBuffer();
  buffer.anthropic({type:"content_block_start",index:0,content_block:{type:"thinking",thinking:""}});
  buffer.anthropic({type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"think"}});
  buffer.anthropic({type:"content_block_delta",index:0,delta:{type:"signature_delta",signature:"sig"}});
  assert.equal(buffer.assistantExtras.anthropicThinking[0].signature,"sig");
  const text=textToolMessages(history); assert.equal(text.at(-1).role,"user");assert.match(text.at(-1).content,/REAL_FIXTURE_BALANCE/);assert.match(text.at(-2).content,/<tool_call>/);assert.ok(!text.at(-2).tool_calls);
  const native=buildSystemPrompt({agent:{tools:["account"]},toolSpecs:[{id:"account",desc:"read",args:"{}"}],nativeTools:true});
  assert.ok(!native.includes("<tool_call>"));assert.match(native,/原生工具调用/);
});
test("三个对外协议的工具回传均保留调用编号、参数、结果与定义",()=>{
  const fn={name:"account",description:"read",parameters:{type:"object",properties:{action:{type:"string"}}}};
  const bodies={
    chat:{messages:history,tools:[{type:"function",function:fn}]},
    messages:{messages:[{role:"user",content:"query"},{role:"assistant",content:[{type:"tool_use",id:tool.id,name:tool.name,input:{action:"overview"}}]},{role:"user",content:[{type:"tool_result",tool_use_id:tool.id,content:"REAL_FIXTURE_BALANCE",is_error:true}]}],tools:[{name:fn.name,input_schema:fn.parameters}]},
    responses:{input:[{role:"user",content:"query"},{type:"function_call",call_id:tool.id,name:tool.name,arguments:tool.arguments},{type:"function_call_output",call_id:tool.id,output:"REAL_FIXTURE_BALANCE"}],tools:[{type:"function",...fn}]},
  };
  for(const [name,body] of Object.entries(bodies)){
    const parsed=PROTOCOLS[name].parse(body);
    assert.equal(parsed.tools[0].name,"account");assert.equal(parsed.messages.at(-1).role,"tool");
    assert.equal(parsed.messages.at(-1).tool_call_id,tool.id);assert.equal(parsed.messages.at(-1).content,"REAL_FIXTURE_BALANCE");
    assert.equal(parsed.messages.at(-2).tool_calls[0].arguments,tool.arguments);
  }
});
