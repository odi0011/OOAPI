// 真正调度输入框上的乐乐，逐帧检查遮挡与离场，不用修改 DOM 类名冒充动画。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE=process.env.BASE||"http://127.0.0.1:4115",OUT="/var/tmp/ooapi-lele-edges-evidence";
const [[db]]=await pool.query("SELECT DATABASE() name");assert.equal(db.name,"ooapi_lele_gate");assert.equal(new URL(BASE).hostname,"127.0.0.1");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=100 AND status=1 ORDER BY role DESC LIMIT 1");
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
await page.addInitScript(t=>localStorage.setItem("ooapi-token",t),signToken(admin));page.on("pageerror",e=>errors.push(e.message));
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log("PASS",label);};
const cases=[...["left","right"].flatMap(edge=>["side-peek","side-scout","side-paw","side-tap"].map((gesture,i)=>({edge,gesture,i}))),...["tail-slip","tail-tip","feet-kick","foot-dangle"].map((gesture,i)=>({edge:"bottom",gesture,i}))];
cases.push(...[{edge:"left",gesture:"side-peek",i:0},{edge:"right",gesture:"side-paw",i:2},{edge:"bottom",gesture:"tail-slip",i:0},{edge:"bottom",gesture:"feet-kick",i:2}].map(c=>({...c,theme:"dark"})));
try {
 await fs.mkdir(OUT,{recursive:true});await page.clock.install();
 for(const {edge,gesture,i,theme} of cases) {
  await page.goto(BASE+"/chat",{waitUntil:"networkidle"});await page.getByRole("textbox",{name:"消息内容"}).waitFor();await page.mouse.move(1,1);
  if(theme){await page.evaluate(t=>localStorage.setItem("ooapi-color-mode",t),theme);await page.reload({waitUntil:"networkidle"});}
  // 固定随机输入，仍由真实的定时器、选边和选动作逻辑生成姿势。
  await page.evaluate(({edge,i})=>{window.__random=Math.random;const values=[({left:1,right:2,bottom:3}[edge]+.1)/6,(i+.1)/4,.5,.5];Math.random=()=>values.length?values.shift():.5;},{edge,i});
  await page.clock.fastForward(24500);await page.clock.fastForward(350);
  const actor=page.locator(".lele-edge-actor"),anchor=page.locator(".lele-perch-anchor");
  assert.equal(await anchor.getAttribute("data-pose"),gesture);check(await anchor.evaluate((n,e)=>n.classList.contains("at-"+e),edge),`${edge} ${gesture} 由调度器正确选出`);
  await page.evaluate(()=>{Math.random=window.__random;});
  await anchor.evaluate(n=>{for(const a of n.getAnimations({subtree:true}))a.pause();});
  const snapshots=[];
  for(const fraction of [0,.25,.5,.75,.99]) {
   await anchor.evaluate((n,f)=>{for(const a of n.getAnimations({subtree:true})){const t=a.effect.getTiming();a.currentTime=Number(t.duration)*f;}},fraction);
   const g=await anchor.evaluate((n,edge)=>{
    const v=n.querySelector(".lele-edge-viewport").getBoundingClientRect(),c=n.parentElement.getBoundingClientRect(),css=s=>getComputedStyle(n.querySelector(s));
    return {boundary:edge==="bottom"?v.top-c.bottom:edge==="left"?v.right-c.left:v.left-c.right,clip:css(".lele-edge-viewport").overflowX,rotation:getComputedStyle(n).transform,body:css(".cat-body").display,head:css(".cat-cranium").display,paws:css(".cat-paws").display,tail:css(".cat-tail").display,grips:n.querySelectorAll(".lele-edge-grip").length,transform:css(".lele-edge-actor").transform,overflow:document.documentElement.scrollWidth>innerWidth+1};
   },edge);
   assert.ok(Math.abs(g.boundary)<1,`${edge} 裁剪边必须贴住输入框`);assert.equal(g.clip,"clip");if(!["side-peek","side-scout"].includes(gesture))assert.equal(g.body,"none");assert.equal(g.grips,0);assert.equal(g.overflow,false);
   if(edge==="bottom"){assert.equal(g.head,"none");assert.equal(g.rotation,"none");assert.equal(g[gesture.startsWith("tail-")?"paws":"tail"],"none");}
   else assert.equal(g[gesture==="side-paw"||gesture==="side-tap"?"head":"paws"],"none");
   if(fraction===.5&&["side-peek","side-scout"].includes(gesture))check(await anchor.evaluate(n=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(n.querySelector(".cat-cranium")).transform).b)>.25),`${edge} 头部实际倾斜探出，不是直切半张正脸`);
   snapshots.push(g);const box=await page.locator(".bui-composer").boundingBox();await page.screenshot({path:`${OUT}/${edge}-${gesture}-${fraction}${theme?"-"+theme:""}.png`,clip:{x:Math.floor(box.x-48),y:Math.floor(box.y-60),width:Math.ceil(box.width+96),height:Math.ceil(box.height+112)}});
  }
  check(new Set(snapshots.map(g=>g.transform)).size>=3,`${edge} ${gesture} 进入、俏皮小动作、收回有实际位移且不穿入框内`);
  // 让真正的 animationend 结束这一小段，不用伪造事件。
  await anchor.evaluate(n=>{for(const a of n.getAnimations({subtree:true}))a.play();});await page.locator(".is-fragment.phase-hidden").waitFor({state:"attached"});
  check(await actor.evaluate(n=>getComputedStyle(n).visibility==="hidden"),`${gesture} 结束后藏回框后`);
 }
 check(errors.length===0,"边缘动作无浏览器运行错误");console.log(`边缘动作专项 ${checks} 项通过`);
}catch(e){await page.screenshot({path:OUT+"/failure.png"}).catch(()=>{});throw e;}
finally {await browser.close();await pool.end();}
