// 真实随机调度 + textarea 输入 + CSS 分帧；不改组件类名或伪造 animationend。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE=process.env.BASE||"http://127.0.0.1:4115", OUT="/var/tmp/ooapi-lele-drape";
const [[db]]=await pool.query("SELECT DATABASE() name");assert.equal(db.name,"ooapi_lele_gate");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=100 AND status=1 ORDER BY role DESC LIMIT 1");
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on("pageerror",e=>errors.push(e.message));await page.addInitScript(t=>localStorage.setItem("ooapi-token",t),signToken(admin));
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log("PASS",label);};
const anchor=page.locator(".lele-perch-anchor"), input=page.getByRole("textbox",{name:"消息内容"});
async function sleepCat(width=1440,theme="light") {
  await page.setViewportSize({width,height:width===1440?1000:844});
  await page.goto(BASE+"/chat",{waitUntil:"networkidle"});
  await page.evaluate(t=>localStorage.setItem("ooapi-color-mode",t),theme);
  await page.reload({waitUntil:"networkidle"});await input.waitFor();await page.mouse.move(1,1);
  if(width===1440 && checks===0) {
    const original=await anchor.locator('.chat-mascot>svg').evaluate(n=>n.outerHTML);
    await fs.writeFile(OUT+'/original.svg',original.replace('aria-hidden="true"','role="img" aria-label="乐乐原型"').replace('shape-rendering="crispEdges">','shape-rendering="crispEdges"><style>.cat-happy-eyes,.cat-sleep-eyes{display:none}</style>'));
  }
  if (await input.inputValue()) { await input.fill(""); await page.waitForTimeout(1500); }
  await page.evaluate(()=>{window.__random=Math.random;const choices=[0,.999,.6,0,0];Math.random=()=>choices.length?choices.shift():0;});
  await page.clock.fastForward(24500);await page.clock.fastForward(350);
  await page.locator(".pose-drape.phase-rest").waitFor({state:"attached",timeout:7000});
  await page.evaluate(()=>{Math.random=window.__random;});
  check(await anchor.getAttribute("data-pose")==="drape",`${width} ${theme} 从真实随机调度进入趴睡`);
}
async function screenshot(name) {
  const r=await page.locator(".bui-composer").boundingBox();
  const x=Math.max(0,Math.floor(r.x-50)),y=Math.max(0,Math.floor(r.y-145));
  await page.screenshot({path:`${OUT}/${name}.png`,clip:{x,y,width:Math.min(page.viewportSize().width-x,Math.ceil(r.width+100)),height:Math.min(page.viewportSize().height-y,Math.ceil(r.height+190))}});
}
async function frames(name) {
  await page.clock.pauseAt(await page.evaluate(()=>Date.now()+20));
  await anchor.evaluate(n=>n.getAnimations({subtree:true}).forEach(a=>a.pause()));
  const rows=[];
  for(const f of [0,.12,.24,.34,.4,.54,.68,.77,.89,.99]) {
    await anchor.evaluate((n,f)=>n.getAnimations({subtree:true}).forEach(a=>{a.currentTime=Number(a.effect.getTiming().duration)*f;}),f);
    const row=await anchor.evaluate(n=>{
      const selectors=[".lele-edge-actor",".cat-cranium",".lounge-body",".lounge-tail",".lounge-front-leg",".lounge-hind-leg",".lounge-folded-paw",".lounge-wrist",".lounge-hock"];
      return {parts:Object.fromEntries(selectors.map(s=>[s,getComputedStyle(n.querySelector(s)).transform])),opacity:getComputedStyle(n.querySelector(".lele-edge-actor")).opacity,edge:n.getBoundingClientRect().top,contacts:[...n.querySelectorAll("[data-drape-contact]")].map(p=>p.getBoundingClientRect().bottom),overflow:document.documentElement.scrollWidth>innerWidth+1,clip:getComputedStyle(n.querySelector(".lele-edge-viewport")).clipPath};
    });
    rows.push(row);await screenshot(`${name}-${f}`);
  }
  check(rows.every(r=>r.opacity==="1"),name+" 全段不以透明度隐藏身体");
  check(rows.every(r=>!r.overflow),name+" 所有帧无横向溢出");
  for(const part of Object.keys(rows[0].parts))check(new Set(rows.map(r=>r.parts[part])).size>=3,name+" "+part+" 有独立姿态变化");
  if(name.startsWith("startle"))check(rows[4].contacts.every(y=>y<=rows[4].edge+1),"启用框沿遮挡前，尾巴和爪子已收回到上方");
  await fs.writeFile(`${OUT}/${name}.json`,JSON.stringify(rows));
  await anchor.evaluate(n=>n.getAnimations({subtree:true}).forEach(a=>a.play()));await page.clock.resume();
  await page.locator(".pose-drape.phase-hidden").waitFor({state:"attached"});
  check(await anchor.locator(".lele-edge-actor").evaluate(n=>getComputedStyle(n).visibility==="hidden"),name+" 动作结束藏到框后");
}
try {
  await fs.mkdir(OUT,{recursive:true});await page.clock.install();
  await sleepCat();
  const anatomy=await anchor.evaluate(n=>{const y=n.getBoundingClientRect().top;return {body:n.querySelector(".lounge-body").getBoundingClientRect().bottom-y,legs:[...n.querySelectorAll("[data-drape-contact]")].map(p=>p.getBoundingClientRect().bottom-y),grips:n.querySelectorAll(".lele-edge-grip").length};});
  check(Math.abs(anatomy.body)<1.5,"侧卧身体贴住上沿，不悬空或埋进输入框");
  check(anatomy.legs.every(y=>y>9)&&anatomy.grips===0,"近侧前腿、后腿与尾巴自然垂下，不附加抓边爪子");
  const joints=await anchor.evaluate(n=>{
    const fore=n.querySelector('.lounge-front-leg'),hind=n.querySelector('.lounge-hind-leg');
    const origin=p=>parseFloat(getComputedStyle(p).transformOrigin);
    return {gap:origin(hind)-origin(fore),folded:n.querySelector('.lounge-folded-paw').getBoundingClientRect().bottom-n.getBoundingClientRect().top};
  });
  check(joints.gap>=18 && joints.folded<2,"前腿接肩、后腿接髋，另一只前爪收在胸前边沿上方");
  await screenshot("sleep-desktop");
  await fs.writeFile(OUT+'/drape-anchor.html',await anchor.evaluate(n=>n.outerHTML));
  const through=await anchor.locator('[data-drape-contact="front-leg"]').evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint((r.left+r.right)/2,r.bottom-2)?.closest("textarea")!==null;});
  check(through,"垂下的爪子不拦截文字区域点击");
  await input.fill("你好");await page.waitForTimeout(150);
  check((await anchor.getAttribute("class")).includes("phase-rest"),"远处输入短句不惊醒");
  const count=await page.evaluate(()=>{const paw=document.querySelector('[data-drape-contact="front-leg"]').getBoundingClientRect(),ta=document.querySelector("textarea.bui-composer-input");return Math.ceil((paw.left-ta.getBoundingClientRect().left)/parseFloat(getComputedStyle(ta).fontSize))+1;});
  await input.fill("写".repeat(count+2));
  await page.locator(".pose-drape.phase-startle").waitFor({state:"attached"});
  check(true,"实际文字接近垂下的爪子触发惊醒");
  await frames("startle-desktop");
  await page.evaluate(()=>{
    window.__drapeFlash=false;
    window.__drapeObserver=new MutationObserver(()=>{if(document.querySelector('.pose-drape.phase-exit'))window.__drapeFlash=true;});
    window.__drapeObserver.observe(document.querySelector('.lele-perch-anchor'),{attributes:true,attributeFilter:['class']});
  });
  await page.clock.fastForward(25000);await page.waitForTimeout(350);
  check(await page.evaluate(()=>{window.__drapeObserver.disconnect();return !window.__drapeFlash && !document.querySelector('.pose-drape');}),"已隐藏的睡姿在下一轮调度时不会闪回重播离场");
  await sleepCat();await page.clock.fastForward(28500);
  await page.locator(".pose-drape.phase-stretch").waitFor({state:"attached"});
  check(true,"没有操作时到期慢慢起身伸懒腰");await frames("stretch-desktop");
  for(const width of [390,320]) {
    await sleepCat(width,width===320?"dark":"light");await screenshot("sleep-"+width);
    await input.fill("远处\n\n\n位于尾巴下方的文字");await page.waitForTimeout(150);
    check((await anchor.getAttribute("class")).includes("phase-rest"),width+" 文字换到尾巴下方但不接触时继续睡");
    const pasted="贴近小尾巴的中文与 English ".repeat(8)+"\n保留换行";
    await page.context().grantPermissions(["clipboard-read","clipboard-write"],{origin:BASE});
    await page.evaluate(t=>navigator.clipboard.writeText(t),pasted);await input.focus();await input.press("Control+A");await input.press("Control+V");
    await page.locator(".pose-drape.phase-startle").waitFor({state:"attached"});
    check(true,width+" 多行长文本粘贴会惊醒，输入内容不丢失");
    assert.equal(await input.inputValue(),pasted);
    await frames("startle-"+width);
  }
  await sleepCat(390);await page.getByRole("button",{name:"选择模型",exact:true}).click();
  await page.locator(".pose-drape.phase-hidden").waitFor({state:"attached"});
  check(await page.locator("[data-promptbar-menu]").isVisible(),"打开菜单时小猫惊醒离场，菜单保持可操作");
  await page.keyboard.press("Escape");await sleepCat(390);await page.emulateMedia({reducedMotion:"reduce"});
  await page.locator(".pose-drape.phase-hidden").waitFor({state:"attached"});check(true,"减少动画模式立即收起悬垂装饰");
  check(errors.length===0,"全部交互无页面运行异常");console.log(`趴睡动作专项 ${checks} 项通过`);
}catch(e){await page.screenshot({path:OUT+"/failure.png"}).catch(()=>{});throw e;}
finally {await browser.close();await pool.end();}
