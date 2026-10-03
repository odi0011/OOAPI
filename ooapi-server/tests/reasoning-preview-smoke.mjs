// 在浏览器网络边界推送受控 SSE，验证真实 React 流式更新和可见末尾，不调用收费模型。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {chromium} from "playwright";
import {pool} from "../src/db.js";
import {signToken} from "../src/middleware/auth.js";
const BASE=process.env.BASE||"http://127.0.0.1:4115",OUT="/var/tmp/ooapi-reasoning-preview-evidence";
const [[db]]=await pool.query("SELECT DATABASE() name");assert.equal(db.name,"ooapi_lele_gate");assert.equal(new URL(BASE).hostname,"127.0.0.1");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=100 AND status=1 ORDER BY role DESC LIMIT 1");
const [[key]]=await pool.query("SELECT id FROM tokens WHERE user_id=? AND group_name=? LIMIT 1",[admin.id,"测试"]);
const token=signToken(admin),headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
const api=async(p,body)=>{const r=await fetch(BASE+"/api/chat"+p,{method:"POST",headers,body:JSON.stringify(body)});const j=await r.json();assert.ok(r.ok&&j.success);return j.data;};
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]}),page=await browser.newPage(),sessions=[],errors=[];
await page.addInitScript(({token,key})=>{
 localStorage.setItem("ooapi-token",token);localStorage.setItem("oo.chat.keyId",key);
 const original=window.fetch;window.fetch=(url,options)=>{
  if(new URL(String(url),location.href).pathname!=="/api/chat/run")return original(url,options);
  const encoder=new TextEncoder();return Promise.resolve(new Response(new ReadableStream({start(controller){
   window.__streamSend=e=>controller.enqueue(encoder.encode("data: "+JSON.stringify(e)+"\n\n"));window.__streamClose=()=>controller.close();
   window.__streamSend({type:"start"});window.__streamSend({type:"part",part:{id:"preview-test",type:"reasoning",text:"The user is asking a philosophical question. ",status:"running"}});
  }}),{headers:{"content-type":"text/event-stream"}}));
 };
},{token,key:String(key.id)});page.on("pageerror",e=>errors.push(e.message));
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log("PASS",label);};
try {
 await fs.mkdir(OUT,{recursive:true});
 for(const width of [1440,390,320]) {
  const session=await api("/sessions",{model:"deepseek-flash"});sessions.push(session.id);await page.setViewportSize({width,height:900});
  await page.goto(BASE+"/chat?s="+session.id,{waitUntil:"networkidle"});await page.getByRole("textbox",{name:"消息内容"}).fill("验证最新思考预览");await page.getByRole("button",{name:"发送消息",exact:true}).click();
  const pill=page.locator('[data-execution-id="preview-test"] .execution-pill'),preview=pill.locator(".execution-pill-preview");await preview.waitFor();
  for(const [i,text]of ["继续核对上下文与请求，".repeat(30)+"现在正在核对最新记录。"," Now compare the latest entries and confirm the result.","\n最后正在整理结论🐾"].entries()){
   await page.evaluate(delta=>window.__streamSend({type:"delta",id:"preview-test",field:"text",delta}),text);await page.waitForTimeout(550);
   check((await preview.innerText()).endsWith(Array.from(text.trim()).slice(-30).join("")),`${width} 第 ${i+1} 段更新到最新内容`);
   check(await preview.evaluate(n=>{const text=n.firstElementChild.firstChild,r=document.createRange();r.setStart(text,Math.max(0,text.length-2));r.setEnd(text,text.length);const end=r.getBoundingClientRect(),box=n.getBoundingClientRect();return end.right<=box.right+1&&end.left>=box.left&&box.width>10;}),`${width} 最新字符真正位于可见裁剪区域`);
   check(!(await preview.innerText()).includes("The user is asking"),`${width} 不再停留在最初几个词`);
  }
  await page.screenshot({path:OUT+`/latest-${width}.png`});await pill.locator("button").click();await page.waitForTimeout(600);
  check((await pill.locator(".execution-thought").innerText()).startsWith("The user is asking")&&(await pill.locator(".execution-thought").innerText()).endsWith("整理结论🐾"),`${width} 展开后完整保留起点和最新进度`);
  await page.mouse.move(1,80);await page.waitForTimeout(600);check((await preview.innerText()).endsWith("整理结论🐾"),`${width} 收回后仍显示末尾`);
  await page.evaluate(()=>{window.__streamSend({type:"part_update",id:"preview-test",patch:{status:"done"}});window.__streamSend({type:"done"});window.__streamClose();});
  await page.waitForTimeout(300);check(await preview.count()===0,`${width} 完成后恢复完成短句`);
 }
 check(errors.length===0,"流式预览没有运行异常");console.log(`最新思考预览 ${checks} 项通过`);
}finally{if(sessions.length)await api("/sessions/batch",{ids:sessions,action:"archive"});await browser.close();await pool.end();}
