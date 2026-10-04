// 独立候选环境：测试真实组件的用户交互与随机调度，不调用收费上游。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { pool } from "../src/db.js";
import { signToken } from "../src/middleware/auth.js";
const BASE=process.env.BASE || "http://127.0.0.1:4115", OUT="/var/tmp/ooapi-lele-actions-evidence";
const [[db]]=await pool.query("SELECT DATABASE() name");
assert.equal(db.name,"ooapi_lele_gate");assert.equal(new URL(BASE).hostname,"127.0.0.1");
const [[admin]]=await pool.query("SELECT * FROM users WHERE role>=100 AND status=1 ORDER BY role DESC LIMIT 1");
const [[key]]=await pool.query("SELECT id FROM tokens WHERE user_id=? AND group_name=? LIMIT 1",[admin.id,"测试"]);
const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
page.on("pageerror",e=>errors.push(e.message));
await page.addInitScript(({token,key})=>{localStorage.setItem("ooapi-token",token);localStorage.setItem("oo.chat.keyId",key);},{token:signToken(admin),key:String(key.id)});
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;console.log("PASS",label);};
try {
  await fs.mkdir(OUT,{recursive:true});
  await page.clock.install();
  await page.goto(BASE+"/chat",{waitUntil:"networkidle"});
  const input=page.getByRole("textbox",{name:"消息内容"});
  await input.fill("我在打字");
  await page.locator(".pose-listen").waitFor({state:"attached"});
  check(await page.locator(".cat-asking-eyes,.cat-annoyed-eyes").count()===0,"保留原有脸部，没有附加眉眼");
  await page.waitForTimeout(220);
  const at=await page.locator(".lele-perch-anchor").getAttribute("style");
  await input.pressSequentially("，乐乐在听",{delay:35});
  check(await page.locator(".lele-perch-anchor").getAttribute("style")===at,"连续输入不反复换位或重播入场");
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent("lele-action",{detail:"copy"})));
  await page.locator(".pose-proud").waitFor({state:"attached"});
  check(true,"复制反馈使用独立动作");
  await page.waitForTimeout(3400);
  // Hover 只叠加微表情；身体和热区锚点必须连续，不能触发随机换姿/逃跑。
  const beforeHover=await page.locator(".lele-perch-anchor").evaluate(n=>{const r=n.getBoundingClientRect();return {pose:n.dataset.pose,x:r.x,y:r.y};});
  await page.locator(".lele-edge-actor").hover({position:{x:29,y:20},force:true});
  await page.waitForTimeout(220);
  const duringHover=await page.locator(".lele-perch-anchor").evaluate(n=>{const r=n.getBoundingClientRect();return {pose:n.dataset.pose,hovered:n.dataset.hovered,x:r.x,y:r.y};});
  check(duringHover.hovered==="true" && duringHover.pose===beforeHover.pose && Math.abs(duringHover.x-beforeHover.x)<.5 && Math.abs(duringHover.y-beforeHover.y)<.5,"悬停确认后叠加微表情，姿势和锚点保持不变");
  await page.mouse.move(1,1);
  await page.waitForTimeout(320);
  check(await page.locator(".lele-perch-anchor").getAttribute("data-hovered")==="false","移出热区后平滑解除悬停状态");
  const beforeMenu=await page.locator(".lele-perch-anchor").evaluate(n=>{const a=n.getBoundingClientRect(),v=n.querySelector(".lele-edge-viewport").getBoundingClientRect();return {x:a.x,y:a.y,cat:{left:v.left,right:v.right,top:v.top,bottom:v.bottom}};});
  await page.getByRole("button",{name:"选择模型",exact:true}).click();
  await page.locator("[data-promptbar-menu]").waitFor();
  const menuBounds=await page.locator("[data-promptbar-menu]").evaluate(n=>{const p=n.offsetParent.getBoundingClientRect();return {left:p.left+n.offsetLeft,right:p.left+n.offsetLeft+n.offsetWidth,top:p.top+n.offsetTop,bottom:p.top+n.offsetTop+n.offsetHeight};});
  const occluded=menuBounds.left<beforeMenu.cat.right && menuBounds.right>beforeMenu.cat.left && menuBounds.top<beforeMenu.cat.bottom && menuBounds.bottom>beforeMenu.cat.top;
  await page.waitForTimeout(1400);
  if(occluded) {
    check(await page.locator(".lele-perch-anchor.at-menu").count()===1,"菜单真实遮挡身体时才跳上菜单");
  } else {
    const still=await page.locator(".lele-perch-anchor").boundingBox();
    check(await page.locator(".lele-perch-anchor.at-menu").count()===0 && Math.abs(still.x-beforeMenu.x)<.5 && Math.abs(still.y-beforeMenu.y)<.5,"菜单没有遮挡身体时保留原位");
    await page.keyboard.press("Escape");await page.locator("[data-promptbar-menu]").waitFor({state:"detached"});
    // 仅在测试浏览器把现有锚点放入已测菜单范围，制造明确遮挡来覆盖跳跃路径。
    await page.locator(".lele-perch-anchor").evaluate((n,m)=>{const p=n.parentElement.getBoundingClientRect(),x=(m.left+m.right)/2;n.style.left=`${x-p.left-29}px`;},menuBounds);
    await page.getByRole("button",{name:"选择模型",exact:true}).click();
    await page.locator(".lele-perch-anchor.at-menu").waitFor({state:"attached"});await page.waitForTimeout(1400);
    check(true,"受控遮挡位置触发菜单跳跃，不依赖悬停逃跑");
  }
  const menuGeometry=await page.evaluate(()=>{const a=document.querySelector(".lele-edge-viewport").getBoundingClientRect(),m=document.querySelector(".bui-upmenu.is-model").getBoundingClientRect();return {bottom:a.bottom,top:m.top,x:a.x,right:a.right};});
  check(Math.abs(menuGeometry.bottom-menuGeometry.top)<1,"遮挡后乐乐依附实际菜单上沿");
  await page.screenshot({path:OUT+"/menu-perch.png",fullPage:true});
  for (const label of ["推理强度", "选择模型", "推理强度"]) {
    await page.getByRole("button",{name:label,exact:true}).click();
    await page.waitForTimeout(1400);
    const g=await page.evaluate(()=>{const a=document.querySelector(".lele-edge-viewport").getBoundingClientRect(),m=document.querySelector("[data-promptbar-menu]").getBoundingClientRect();return {bottom:a.bottom,top:m.top,x:a.x+a.width/2,left:m.left,right:m.right};});
    check(Math.abs(g.bottom-g.top)<1 && g.x>g.left && g.x<g.right,"直接切到"+label+"后重新落在实际菜单上沿");
  }
  await page.screenshot({path:OUT+"/menu-switch.png",fullPage:true});
  for (const label of ["选择模型","推理强度","选择模型","推理强度"]) {
    await page.getByRole("button",{name:label,exact:true}).click();await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1400);
  check(await page.evaluate(()=>Math.abs(document.querySelector(".lele-edge-viewport").getBoundingClientRect().bottom-document.querySelector("[data-promptbar-menu]").getBoundingClientRect().top)<1),"快速切换打断动画后仍落到最后一个菜单");
  await page.keyboard.press("Escape");await page.locator(".pose-drop.phase-enter").waitFor({state:"attached"});
  check(true,"菜单关闭触发从菜单高度落下的动作");
  await page.waitForTimeout(180);await page.screenshot({path:OUT+"/menu-drop.png",fullPage:true});
  await page.waitForTimeout(800);
  check(await page.locator(".at-menu").count()===0,"落下后恢复输入框边界");
  // 真实调度器配合虚拟时间；每次推进后保留可见姿态，避免只检查 CSS 类名。
  const seen=new Map();
  await input.fill("");await page.clock.fastForward(2200);
  for(let i=0;i<220 && seen.size<25;i++) {
    await page.clock.fastForward(24500);await page.clock.fastForward(1100);
    const pose=await page.locator(".lele-perch-anchor").getAttribute("data-pose");
    if(!seen.has(pose)) {
      const element=page.locator(".lele-perch-anchor");
      const g=await element.evaluate(n=>({edge:["top","left","right","bottom"].find(e=>n.classList.contains("at-"+e)),grip:!!n.querySelector(".lele-edge-grip")}));
      if(["belly","sleep","curl","zzz","pop","walk","toy","lick","groom","wash"].includes(pose)) check(!g.grip,pose+"不附加抓边爪子");
      if(pose==="wash") check(await element.locator(".cat-paw-right .cat-paw-ground").evaluate(n=>getComputedStyle(n).display==="none"),"洗脸抬爪不带脚掌底部黑条");
      seen.set(pose,g);
      await element.evaluate(n=>{ for(const a of n.getAnimations({subtree:true})) { a.pause(); const timing=a.effect.getTiming(); a.currentTime=Number(timing.duration)*(timing.iterations===Infinity?.45:1); } });
      await page.screenshot({path:OUT+"/pose-"+pose+".png",fullPage:true});
    }
  }
  check(seen.size>=15,"真实随机调度覆盖至少 15 种动作");
  await fs.writeFile(OUT+"/poses.json",JSON.stringify(Object.fromEntries(seen),null,2));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"动作与菜单无整页横向溢出");
  await page.emulateMedia({reducedMotion:"reduce"});
  check(await page.locator(".lele-edge-actor").evaluate(n=>getComputedStyle(n).animationName==="none"),"减少动画模式停用动作");
  check(errors.length===0,"交互无运行异常");
  console.log(`乐乐动作专项 ${checks} 项通过，${seen.size} 种真实调度姿态`);
} catch(e) {await page.screenshot({path:OUT+"/failure.png",fullPage:true}).catch(()=>{});throw e;}
finally {await browser.close();await pool.end();}
