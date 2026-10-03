import test from "node:test";
import assert from "node:assert/strict";
import { createReasoningFilter, hasReasoningText, normalizeReasoningAdapter } from "../src/services/reasoning-content.js";
import { getAdapter, supportedTypes } from "../src/services/router.js";
import { PROTOCOLS } from "../src/services/gateway-protocols.js";
import { hasReasoningText as visibleThought } from "../../ooapi-web/src/services/reasoning-display.js";
import { executionEntries, presentation } from "../../ooapi-web/src/components/executionPresentation.js";

const placeholders = ["", " ", "\n\r\t", "...", "…", "……", "\u200B\u200C\u200D\u2060\uFEFF", " \n... … "];
test("占位判断前后端一致，真实文本/数字/符号不被误删", () => {
  for (const value of [...placeholders, null, {}, []]) { assert.equal(hasReasoningText(value), false); assert.equal(visibleThought(value), false); }
  for (const value of [" ... real reasoning\n", "3.14", "因为如此……", "1 + 1", "✓", "Σ", "?"]) { assert(hasReasoningText(value)); assert(visibleThought(value)); }
});
test("分片在首个有效内容前暂存，不丢真实思考的排版", () => {
  const chunks = [], filter = createReasoningFilter(t=>chunks.push(t));
  filter.push(" \n"); filter.push("..."); assert.deepEqual(chunks, []);
  filter.push("实际"); filter.push(" "); filter.push("思路\n"); filter.push("...");
  assert.equal(filter.finish(), " \n...实际 思路\n..."); assert.equal(chunks.join(""), " \n...实际 思路\n...");
  filter.push("迟到的片段"); assert.equal(chunks.join(""), " \n...实际 思路\n...");
});
test("正文/工具之后的新占位不能重开思考；最终快照补全文本不重复", () => {
  const chunks = [], filter = createReasoningFilter(t=>chunks.push(t));
  filter.push("真正思考"); filter.boundary(); filter.push("..."); filter.boundary(); filter.push("\n");
  assert.equal(filter.finish("真正思考...\n"), "真正思考"); assert.deepEqual(chunks, ["真正思考"]);
  const complete = createReasoningFilter(); complete.push("...思"); assert.equal(complete.finish("...思考完成"), "...思考完成");
});
test("所有已注册的上游适配器均经过统一出口，不能遗漏薄封装渠道", async () => {
  for (const key of supportedTypes()) {
    const original = await import(`../src/services/upstream/${key === "grok-oauth" ? "grok" : key}.js`);
    const adapter = await getAdapter(key);
    if (original.chat) assert.notEqual(adapter.chat, original.chat, key);
    assert.equal(adapter, await getAdapter(key), key);
    for (const name of Object.keys(original).filter(k=>k!=="chat")) assert.equal(adapter[name], original[name], `${key}.${name}`);
  }
});
test("流式/非流式与错误出口都过滤占位，真实用量与工具签名保持不变", async () => {
  const usage = {prompt_tokens:8,completion_tokens:12,reasoning_tokens:9};
  const assistantExtras = {signature:"fixture-signature"};
  for (const placeholder of placeholders) {
    const thoughts=[];
    const adapter=normalizeReasoningAdapter({async chat(args){args.onDelta("回答");args.onReasoning(placeholder);return {content:"回答",reasoning:placeholder,usage,assistantExtras};}});
    const result=await adapter.chat({onReasoning:t=>thoughts.push(t)});
    assert.deepEqual(thoughts,[]);assert.equal(result.reasoning,"");assert.equal(result.usage,usage);assert.equal(result.assistantExtras,assistantExtras);
  }
  const finalOnly=normalizeReasoningAdapter({async chat(){return {content:"回答",reasoning:"真实思考"};}});
  const emitted=[];assert.equal((await finalOnly.chat({onReasoning:t=>emitted.push(t)})).reasoning,"真实思考");assert.deepEqual(emitted,["真实思考"]);
  const failed=normalizeReasoningAdapter({async chat(args){args.onReasoning("...");throw Object.assign(new Error("fixture failure"),{reasoning:"...",usage,billable:true});}});
  await assert.rejects(()=>failed.chat({}),e=>e.reasoning===""&&e.usage===usage&&e.billable===true);
});

function response() { return {chunks:[],body:null,status(){return this;},setHeader(){},flushHeaders(){},write(t){this.chunks.push(t);},end(){},json(value){this.body=value;}}; }
const events = res => res.chunks.join("").split("\n").filter(l=>l.startsWith("data: ")&&!l.includes("[DONE]")).map(l=>JSON.parse(l.slice(6)));
const thoughtDeltas = res => events(res).flatMap(e=>e.choices?.[0]?.delta?.reasoning_content !== undefined ? [e.choices[0].delta.reasoning_content] : e.type === "response.reasoning_summary_text.delta" ? [e.delta] : e.delta?.type === "thinking_delta" ? [e.delta.thinking] : []);
const hasThoughtItem = data => JSON.stringify(data).includes('"type":"reasoning"') || JSON.stringify(data).includes('"type":"thinking"') || JSON.stringify(data).includes('"reasoning_content":');
for (const [name, protocol] of Object.entries(PROTOCOLS)) {
  test(`${name} 流式/非流式不创建占位思考项`, () => {
    const res=response(), state=protocol.openStream(res,"fixture","fixture-model");
    for(const text of placeholders)protocol.reasoning(state,text);
    protocol.delta(state,"回答");protocol.reasoning(state,"...");
    protocol.done(res,state,{settled:{promptTokens:1,completionTokens:1}});
    assert.deepEqual(thoughtDeltas(res),[]);assert.equal(hasThoughtItem(events(res)),false);
    for(const reasoning of placeholders){const json=response();protocol.finish(json,{id:"fixture",model:"fixture-model",content:"回答",reasoning,settled:{promptTokens:1,completionTokens:1}});assert.equal(hasThoughtItem(json.body),false);}
  });
  test(`${name} 真实思考完整保留且正文后的占位不会生成第二个块`, () => {
    const res=response(),state=protocol.openStream(res,"fixture","fixture-model");
    protocol.reasoning(state,"\n...");protocol.reasoning(state,"真实");protocol.reasoning(state," ");protocol.reasoning(state,"思考");
    protocol.delta(state,"回答");protocol.reasoning(state,"...");protocol.done(res,state,{settled:{}});
    assert.equal(thoughtDeltas(res).join(""),"\n...真实 思考");
    const added=events(res).filter(e=>e.type==="response.output_item.added"&&e.item.type==="reasoning"||e.type==="content_block_start"&&e.content_block.type==="thinking");
    if(name!=="chat")assert.equal(added.length,1);
  });
}

function awsFrame(type,payload) {
  const field=(name,value)=>{const n=Buffer.from(name),v=Buffer.from(value);return Buffer.concat([Buffer.from([n.length]),n,Buffer.from([7,0,v.length]),v]);};
  const headers=Buffer.concat([field(":event-type",type),field(":message-type","event")]),body=Buffer.from(JSON.stringify(payload)),prelude=Buffer.alloc(12);
  prelude.writeUInt32BE(16+headers.length+body.length);prelude.writeUInt32BE(headers.length,4);
  return Buffer.concat([prelude,headers,body,Buffer.alloc(4)]);
}
test("Kiro auto 实际帧形态：正文后 signature + text='...' 不向客户端暴露思考", async () => {
  const originalFetch=globalThis.fetch;
  try {
    const binary=Buffer.concat([awsFrame("assistantResponseEvent",{content:"OK"}),awsFrame("reasoningContentEvent",{signature:"fixture-signature",text:"..."}),awsFrame("messageMetadataEvent",{usage:{inputTokens:2,outputTokens:3}})]);
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(binary.subarray(0,37));c.enqueue(binary.subarray(37));c.close();}}),{status:200});
    const thought=[],text=[];const adapter=await getAdapter("kiro");
    const result=await adapter.chat({channel:{id:999,other:{access_token:"fixture",expires_at:Math.floor(Date.now()/1000)+3600}},model:"auto",prompt:"fixture",onReasoning:t=>thought.push(t),onDelta:t=>text.push(t)});
    assert.equal(result.reasoning,"");assert.deepEqual(thought,[]);assert.deepEqual(text,["OK"]);assert.equal(result.usage.completion_tokens,3);
  } finally {globalThis.fetch=originalFetch;}
});
test("站内历史空思考隐藏，等待状态不会伪装成思考完成", () => {
  const parts=placeholders.map((text,i)=>({id:String(i),type:"reasoning",text,status:"done"}));
  assert.deepEqual(executionEntries(parts,false),[]);
  parts.push({id:"real",type:"reasoning",text:"确实有内容",status:"done"});
  assert.equal(executionEntries(parts,false).length,1);
  assert.equal(presentation({type:"waiting"},true).thought,false);assert.match(presentation({type:"waiting"},true).label,/等待/);
});
