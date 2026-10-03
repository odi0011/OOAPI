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
 await page.waitForTimeout(550);
 // 必须逐枚点：只测首枚发现不了隐藏前置同伴后，按钮移走触发 pointerleave 的回归。
 const exerciseCapsules=async(group,label)=>{
  const buttons=group.locator(".execution-pill-toggle"),count=await buttons.count();
  for(let i=0;i<count;i++) {
   await page.mouse.move(1,90);await group.evaluate(n=>n.scrollIntoView({block:"center"}));await page.waitForTimeout(100);
   const button=buttons.nth(i),step=group.locator(".execution-step").nth(i);
   await button.scrollIntoViewIfNeeded();
   const original=await group.evaluate((n,i)=>{
    const nodes=[...n.children],selected=nodes[i];return {peers:nodes.filter(c=>c!==selected&&Math.abs(c.offsetTop-selected.offsetTop)<2).map(c=>c.dataset.executionId),boxes:nodes.map(c=>({x:c.offsetLeft,y:c.offsetTop}))};
   },i);
   // 用真实鼠标点击并逐帧检查命中区域，不能用 evaluate().click() 绕过浏览器指针事件。
   await button.evaluate(n=>n.addEventListener("click",e=>{
    window.__capsuleFrames=[];const pill=n.closest(".execution-pill"),start=performance.now();
    const sample=()=>{const r=pill.getBoundingClientRect();window.__capsuleFrames.push({open:pill.classList.contains("is-open"),inside:e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom});if(performance.now()-start<650)requestAnimationFrame(sample);};requestAnimationFrame(sample);
   },{once:true}));
   await button.click();await page.waitForTimeout(1000);
   const frames=await page.evaluate(()=>window.__capsuleFrames);
   assert.ok(frames.length>10&&frames.every(f=>f.open&&f.inside),`${label} 第 ${i+1} 枚展开动画不得移走鼠标命中区：${JSON.stringify(frames)}`);
   assert.equal(await button.getAttribute("aria-expanded"),"true",`${label} 第 ${i+1} 枚停留一秒仍展开`);
   assert.ok(await step.evaluate(n=>Math.abs(n.querySelector(".execution-pill").getBoundingClientRect().left-n.parentElement.getBoundingClientRect().left)<1),"展开详情与回答保持同一左边线");
   assert.deepEqual((await group.locator("[hidden]").evaluateAll(ns=>ns.map(n=>n.dataset.executionId))).sort(),original.peers.sort());
   const detail=step.locator(".execution-detail.is-open>div"),box=await detail.boundingBox();assert.ok(box&&box.height>20,"详情实际占有可读高度");
   // 从原点击点连续移入正文，经过动画后的按钮边缘，详情不能提前关闭。
   await page.mouse.move(box.x+Math.min(60,box.width/2),box.y+Math.min(25,box.height/2),{steps:12});await page.waitForTimeout(100);
   assert.equal(await button.getAttribute("aria-expanded"),"true","鼠标连续进入详情仍展开");
   if(i===0) {await page.mouse.wheel(0,180);await page.waitForTimeout(120);assert.ok(await detail.evaluate(n=>n.scrollTop>0),"长思考详情可实际滚动阅读");}
   if(i===count-1||i===3) {
    // 会话已有自己的滚动容器，拍摄真实视口；fullPage 会临时改动浏览器视口与命中环境。
    await page.screenshot({path:OUT+`/expanded-${label}-${i}.png`});
    assert.equal(await button.getAttribute("aria-expanded"),"true","截图后的详情仍展开，不能只验证截图之前的状态");
   }
   await page.mouse.move(1,90,{steps:8});await page.waitForTimeout(650);
   assert.equal(await group.locator(".execution-detail.is-open,[hidden]").count(),0,"真正移出后恢复同行");
   const restored=await group.evaluate(n=>[...n.children].map(c=>({x:c.offsetLeft,y:c.offsetTop})));
   assert.deepEqual(restored,original.boxes,"收回后每枚胶囊恢复原来的行和位置");
   check(true,`${label} 第 ${i+1} 枚：逐帧展开、停留、移入阅读、移出复位`);
  }
 };
 await exerciseCapsules(trajectory,"desktop");
 const rapid=trajectory.locator(".execution-pill-toggle").nth(3);
 await trajectory.evaluate(n=>n.scrollIntoView({block:"center"}));await rapid.click();await page.waitForTimeout(70);
 const clickHeader=async()=>{const b=await rapid.boundingBox();await page.mouse.click(b.x+b.width/2,b.y+b.height/2);};
 await clickHeader();await page.waitForTimeout(80);await clickHeader();await page.waitForTimeout(700);
 check(await rapid.getAttribute("aria-expanded")==="true","快速收回途中再次点击仍能完整展开");
 await page.mouse.move(1,90);await page.waitForTimeout(550);
 await page.emulateMedia({reducedMotion:"reduce"});await rapid.click();await page.waitForTimeout(250);
 check(await rapid.getAttribute("aria-expanded")==="true","减少动画模式下后置胶囊仍稳定展开");
 await page.mouse.move(1,90);await page.waitForTimeout(50);
 check(await trajectory.locator("[hidden]").count()===0,"减少动画模式即时恢复同行");await page.emulateMedia({reducedMotion:"no-preference"});
 await rapid.click();await page.waitForTimeout(600);await page.mouse.move(1,90);await page.waitForTimeout(550);
 await rapid.focus();await page.keyboard.press("Enter");await page.waitForTimeout(600);
 await page.setViewportSize({width:1440,height:1050});await page.waitForTimeout(150);
 check(await rapid.getAttribute("aria-expanded")==="true","只有视口高度变化时不打断详情阅读");
 await page.setViewportSize({width:1200,height:1050});await page.waitForTimeout(550);
 check(await trajectory.locator("[hidden],.execution-detail.is-open").count()===0,"内容宽度变化后重新排布恢复胶囊");
 await page.setViewportSize({width:1440,height:1000});
 check(await page.locator(".ui-msg-user .bubble").first().evaluate(n=>getComputedStyle(n).borderTopWidth==="0px"),"用户气泡没有边框");
 check(await page.locator(".chat-run-flow").count()===0 && await page.locator(".ui-chat2-head-actions [aria-label=新建对话]").count()===0,"进度浮窗和重复新建入口移除");
 await page.locator(".ui-chat2-shelf-toolbar [aria-label=命令面板]").click();await page.getByRole("dialog").waitFor();
 check(true,"左侧命令面板入口可正常打开");await page.locator(".bui-command-modal .ant-modal-close").click();
 for(const width of [1440,390,320]) for(const theme of ["light","dark"]) {
   await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(t=>localStorage.setItem("ooapi-color-mode",t),theme);await page.reload({waitUntil:"networkidle"});
   await rail.locator("button").first().click();await page.waitForTimeout(700);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${theme} 无横向溢出`);
   await page.screenshot({path:OUT+`/layout-${width}-${theme}.png`,fullPage:true});
   if(width!==1440||theme==="dark") await exerciseCapsules(page.locator(".agent-trajectory").last(),`${width}-${theme}-last-turn`);
 }
 const touch=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await touch.addInitScript(t=>localStorage.setItem("ooapi-token",t),token);await touch.goto(BASE+"/chat?s="+session.id,{waitUntil:"networkidle"});
 const touchPill=touch.locator(".agent-trajectory").last().locator(".execution-pill-toggle").nth(3);await touchPill.tap();await touch.waitForTimeout(700);
 check(await touchPill.getAttribute("aria-expanded")==="true","触屏点击后详情保持可读");await touchPill.tap();await touch.waitForTimeout(600);
 check(await touchPill.getAttribute("aria-expanded")==="false","触屏再次点击收回");await touch.close();
 check(errors.length===0,"多轮导航与胶囊交互无运行错误");console.log(`会话导航与胶囊专项 ${checks} 项通过`);
}catch(e){await page.screenshot({path:OUT+"/failure.png",fullPage:true}).catch(()=>{});throw e;}
finally {await api("/sessions/batch",{ids:[session.id],action:"archive"});await browser.close();await pool.end();}
