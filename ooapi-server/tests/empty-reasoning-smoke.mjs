// 隔离库 + 本地上游桩；真实 HTTP、React 流式更新与历史消息回放，不修改线上数据。
import "dotenv/config";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import { appendMessage } from "../src/services/harness/sessions.js";
const BASE=process.env.BASE||"http://127.0.0.1:4265";
const [[db]]=await pool.query("SELECT DATABASE() name");assert.equal(db.name,"ooapi_reasoning_gate");assert.equal(new URL(BASE).hostname,"127.0.0.1");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=1000 AND status=1 LIMIT 1");
const [[key]]=await pool.query("SELECT id,key_str FROM tokens WHERE user_id=? AND group_name=? LIMIT 1",[admin.id,"测试"]);
const token=signToken(admin),headers={authorization:"Bearer "+token,"content-type":"application/json"};
const api=async(path,body)=>{const res=await fetch(BASE+"/api/chat"+path,{headers,...(body?{method:"POST",body:JSON.stringify(body)}:{})});const json=await res.json();assert(res.ok&&json.success!==false,json.message);return json.data;};
const parseEvents=text=>text.split("\n").filter(l=>l.startsWith("data: ")&&!l.includes("[DONE]")).map(l=>JSON.parse(l.slice(6)));
const hasThought=data=>/"type":"(?:reasoning|thinking)"|"reasoning_content":|"type":"thinking_delta"|"type":"response\.reasoning_/.test(JSON.stringify(data));
const sessions=[];
const newSession=async()=>{const s=await api("/sessions",{model:"deepseek-flash",settings:{tools:[]}});sessions.push(s.id);return s;};
let browser;
try {
 for(const protocol of ["chat/completions","messages","responses"])for(const stream of [false,true])for(const placeholder of [true,false]){
  const prompt=placeholder?"placeholder-fixture":"meaningful-fixture";
  const body={model:"deepseek-flash",stream,max_tokens:256,...(protocol==="responses"?{input:prompt}:{messages:[{role:"user",content:prompt}]})};
  const res=await fetch(BASE+"/v1/"+protocol,{method:"POST",headers:{authorization:"Bearer "+key.key_str,"content-type":"application/json","user-agent":"ZCode/fixture"},body:JSON.stringify(body)});
  assert.equal(res.status,200);const raw=await res.text(),data=stream?parseEvents(raw):JSON.parse(raw);
  assert.equal(hasThought(data),!placeholder,`${protocol} stream=${stream} placeholder=${placeholder}`);
  assert(raw.includes("OK - Agent gateway fixture response"));
 }
 console.log("PASS three real HTTP protocols × streaming/JSON × placeholder/real reasoning");
 const session=await newSession();
 const res=await fetch(BASE+"/api/chat/run",{method:"POST",headers,body:JSON.stringify({sessionId:session.id,keyId:key.id,text:"placeholder-fixture"})});assert.equal(res.status,200);
 const run=parseEvents(await res.text());assert(!run.some(e=>e.type==="error"));assert(!run.some(e=>e.type==="part"&&e.part?.type==="reasoning"));
 const stored=await api("/sessions/"+session.id);assert(stored.messages.some(m=>m.role==="assistant"));assert(!stored.messages.some(m=>m.parts?.some(p=>p.type==="reasoning")));
 console.log("PASS harness stream and persisted message contain no placeholder reasoning");
 const history=await newSession();
 await appendMessage({sessionId:history.id,userId:admin.id,role:"assistant",parts:[{id:"old-empty",type:"reasoning",text:"...",status:"done"},{id:"old-real",type:"reasoning",text:"历史真实思考",status:"done"},{id:"old-text",type:"text",text:"历史正文正常保留"}]});
 browser=await chromium.launch({headless:true,args:["--no-sandbox"]});const page=await browser.newPage(),errors=[];
 await page.addInitScript(({token,key})=>{
  localStorage.setItem("ooapi-token",token);localStorage.setItem("oo.chat.keyId",String(key));localStorage.setItem("ooapi-color-mode","light");
  const original=window.fetch;window.fetch=(url,options)=>{
   if(new URL(String(url),location.href).pathname!=="/api/chat/run")return original(url,options);
   const encoder=new TextEncoder();return Promise.resolve(new Response(new ReadableStream({start(c){window.__reasoningEvent=e=>c.enqueue(encoder.encode("data: "+JSON.stringify(e)+"\n\n"));window.__reasoningClose=()=>c.close();window.__reasoningEvent({type:"start"});}}),{headers:{"content-type":"text/event-stream"}}));
  };
 },{token,key:key.id});page.on("pageerror",e=>errors.push(e.message));
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.goto(BASE+"/chat?s="+history.id,{waitUntil:"networkidle"});
  await page.getByText("历史正文正常保留",{exact:true}).waitFor();assert.equal(await page.locator('[data-execution-id="old-empty"]').count(),0);assert.equal(await page.locator('[data-execution-id="old-real"]').count(),1);
  const live=await newSession();await page.goto(BASE+"/chat?s="+live.id,{waitUntil:"networkidle"});await page.getByRole("textbox",{name:"消息内容"}).fill("界面空思考检查");await page.getByRole("button",{name:"发送消息",exact:true}).click();
  await page.getByRole("button",{name:"正在等待模型响应…",exact:true}).waitFor();assert.equal(await page.locator('[data-execution-type="reasoning"]').count(),0);
  await page.evaluate(()=>window.__reasoningEvent({type:"part",part:{id:"live-empty",type:"reasoning",text:" \n...",status:"running"}}));
  await page.waitForTimeout(100);assert.equal(await page.locator('[data-execution-id="live-empty"]').count(),0);
  await page.evaluate(()=>{window.__reasoningEvent({type:"part",part:{id:"live-real",type:"reasoning",text:"",status:"running"}});window.__reasoningEvent({type:"delta",id:"live-real",field:"text",delta:"真实思考内容正常显示"});});
  await page.locator('[data-execution-id="live-real"]').waitFor();
  await page.evaluate(()=>{window.__reasoningEvent({type:"part_update",id:"live-real",patch:{status:"done"}});window.__reasoningEvent({type:"part",part:{id:"live-text",type:"text",text:"界面正文正常显示"}});window.__reasoningEvent({type:"part",part:{id:"trailing-empty",type:"reasoning",text:"...",status:"done"}});window.__reasoningEvent({type:"done"});window.__reasoningClose();});
  await page.getByText("界面正文正常显示",{exact:true}).waitFor();assert.equal(await page.locator('[data-execution-type="reasoning"]').count(),1);assert.equal(await page.locator('[data-execution-type="waiting"]').count(),0);
  await page.screenshot({path:`/var/tmp/ooapi-empty-reasoning-${width}.png`});
 }
 assert.deepEqual(errors,[]);console.log("PASS desktop/mobile: historical placeholders hidden; waiting distinct; real thought and answer preserved; no runtime errors");
}finally{if(sessions.length)await api("/sessions/batch",{ids:sessions,action:"archive"});await browser?.close();await pool.end();}
