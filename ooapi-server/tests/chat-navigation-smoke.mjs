// 隔离库中的多轮记录，验证导航与胶囊交互；不调用真实上游。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
import { appendMessage } from "../src/services/harness/sessions.js";
const BASE=process.env.BASE||"http://127.0.0.1:4115",OUT="/var/tmp/ooapi-chat-navigation-evidence";
const [[db]]=await pool.query("SELECT DATABASE() name");assert.equal(db.name,"ooapi_lele_gate");assert.equal(new URL(BASE).hostname,"127.0.0.1");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=100 ORDER BY role DESC LIMIT 1");
const token=signToken(admin),headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
const api=async(p,body)=>{const r=await fetch(BASE+"/api/chat"+p,{method:"POST",headers,body:JSON.stringify(body)});const j=await r.json();assert.ok(r.ok&&j.success,j.message);return j.data;};
const session=await api("/sessions",{model:"deepseek-flash"});
const tools=[{type:"reasoning",text:"先核对数据，再整理结论。\n".repeat(22)},{type:"tool",tool:"account",args:{action:"recent"}},{type:"tool",tool:"account",args:{action:"errors"}},{type:"tool",tool:"account",args:{action:"tokens"}},{type:"tool",tool:"account",args:{action:"usage"}},{type:"tool",tool:"search"},{type:"tool",tool:"fetch"},{type:"tool",tool:"github"},{type:"compaction",text:"已收好本轮重点。"}];
for(let i=0;i<4;i++) {
 await appendMessage({sessionId:session.id,userId:admin.id,role:"user",parts:[{id:`u${i}`,type:"text",text:`第 ${i+1} 个问题：帮我整理这一轮资料`}]});
 await appendMessage({sessionId:session.id,userId:admin.id,role:"assistant",parts:[...tools.map((p,k)=>({...p,id:`p${i}-${k}`,status:"done",output:"已准备好这一项结果。"})),{id:`a${i}`,type:"text",text:`第 ${i+1} 轮回答：资料已经整理完成。\n\n`+"这一段保留清晰的上下文，方便从左侧定位回到这一轮。\n\n".repeat(6)}]});
}
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
await page.addInitScript(token=>localStorage.setItem("ooapi-token",token),token);page.on("pageerror",e=>errors.push(e.message));
let checks=0;const check=(v,s)=>{assert.ok(v,s);checks++;console.log("PASS",s);};
try {
 await fs.mkdir(OUT,{recursive:true});await page.goto(BASE+"/chat?s="+session.id,{waitUntil:"networkidle"});
 const rail=page.getByRole("navigation",{name:"对话消息导航"});await rail.locator("button").first().waitFor();
 check(await rail.locator("button").count()===4,"每一轮用户消息对应一个定位刻度");
 check(await rail.locator("button").last().getAttribute("aria-current")==="step","滚动到底时高亮最后一轮");
 await rail.locator("button").first().hover();await page.getByRole("tooltip").waitFor();
 check((await page.getByRole("tooltip").innerText()).includes("第 1 轮回答"),"刻度悬停预览问题与回答");
 await page.screenshot({path:OUT+"/rail-preview.png",fullPage:true});
 await rail.locator("button").first().click();await page.waitForTimeout(800);await page.mouse.move(900,100);
 check(await page.locator(".ui-chat2-thread").evaluate(n=>n.scrollTop<60),"点击第一轮实际滚动到开头");
 check(await rail.locator("button").first().getAttribute("aria-current")==="step","当前阅读位置高亮");
 const trajectory=page.locator(".agent-trajectory").first();
 const peers=await trajectory.evaluate(n=>{const first=n.firstElementChild;return [...n.children].filter(c=>c!==first&&Math.abs(c.offsetTop-first.offsetTop)<2).map(c=>c.dataset.executionId);});
 check(peers.length>0,"桌面胶囊按自然宽度同排");
 const poses=await trajectory.locator(".chat-mascot").evaluateAll(nodes=>nodes.map(n=>{const css=s=>getComputedStyle(n.querySelector(s)).transform;return [css(".cat-cranium"),css(".cat-paw-left"),css(".cat-paw-right")].join("/");}));
 check(new Set(poses).size===poses.length,"不同方法具有不同的完成姿态");
 await trajectory.screenshot({path:OUT+"/capsules.png"});
 await trajectory.locator(".execution-pill-toggle").first().click();await page.waitForTimeout(650);
 const hidden=await trajectory.locator(".execution-step[hidden]").evaluateAll(ns=>ns.map(n=>n.dataset.executionId));
 check(JSON.stringify(hidden.sort())===JSON.stringify(peers.sort()),"展开时只隐藏原本同行的其他胶囊");
 check(await trajectory.locator(".execution-step:not([hidden])").count()>1,"其他行的胶囊继续显示");
 await trajectory.locator(".execution-detail.is-open").hover();
 check(await trajectory.locator(".execution-detail.is-open").count()===1,"指针进入详情后仍可阅读");
 await page.screenshot({path:OUT+"/capsule-expanded.png",fullPage:true});
 await page.mouse.move(900,100);await page.waitForTimeout(500);
 check(await trajectory.locator(".execution-detail.is-open").count()===0 && await trajectory.locator("[hidden]").count()===0,"移出胶囊后自动收回并恢复同行");
 await trajectory.locator(".execution-pill-toggle").first().focus();await page.keyboard.press("Enter");await page.keyboard.press("Escape");
 check(await trajectory.locator(".execution-detail.is-open").count()===0,"键盘可展开并按 Escape 收回");
 check(await page.locator(".ui-msg-user .bubble").first().evaluate(n=>getComputedStyle(n).borderTopWidth==="0px"),"用户气泡没有边框");
 check(await page.locator(".chat-run-flow").count()===0 && await page.locator(".ui-chat2-head-actions [aria-label=新建对话]").count()===0,"进度浮窗和重复新建入口移除");
 await page.locator(".ui-chat2-shelf-toolbar [aria-label=命令面板]").click();await page.getByRole("dialog").waitFor();
 check(true,"左侧命令面板入口可正常打开");await page.locator(".bui-command-modal .ant-modal-close").click();
 for(const width of [1440,390,320]) for(const theme of ["light","dark"]) {
   await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(t=>localStorage.setItem("ooapi-color-mode",t),theme);await page.reload({waitUntil:"networkidle"});
   await rail.locator("button").first().click();await page.waitForTimeout(700);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${theme} 无横向溢出`);
   await page.screenshot({path:OUT+`/layout-${width}-${theme}.png`,fullPage:true});
 }
 check(errors.length===0,"多轮导航与胶囊交互无运行错误");console.log(`会话导航与胶囊专项 ${checks} 项通过`);
}catch(e){await page.screenshot({path:OUT+"/failure.png",fullPage:true}).catch(()=>{});throw e;}
finally {await api("/sessions/batch",{ids:[session.id],action:"archive"});await browser.close();await pool.end();}
