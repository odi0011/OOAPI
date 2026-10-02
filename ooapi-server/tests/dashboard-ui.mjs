// 四页真实浏览器回归：明暗主题、窄屏、厂商注册表与十秒版本刷新通知。
// BASE 指向候选服务；DOTENV_CONFIG_PATH 指向同一候选库。截图保存在系统临时目录。
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
const BASE=process.env.BASE || 'http://127.0.0.1:3001';
const OUT=path.join(os.tmpdir(),'ooapi-home-dashboard-review'); fs.mkdirSync(OUT,{recursive:true});
const [[admin]]=await pool.query('SELECT id,role,token_version FROM users WHERE role >= 100 LIMIT 1');
const token=signToken(admin);
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const errors=[]; let checks=0;
function check(name,value){assert.ok(value,name);checks++;console.log('  ok '+name);}
try{
 for(const [theme,width] of [['light',1440],['dark',1440],['light',390],['dark',390],['light',320]]){
  const ctx=await browser.newContext({viewport:{width,height:1000}});
  await ctx.addInitScript(({theme,token})=>{localStorage.setItem('ooapi-theme',theme);localStorage.setItem('ooapi-token',token);},{theme,token});
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  for(const [route,name] of [['/','home'],['/console','console'],['/admin/dashboard','platform'],['/admin/monitor','monitor']]){
   await page.goto(BASE+route,{waitUntil:'networkidle'});await page.waitForTimeout(400);
   check(name+' '+theme+' '+width+' 无页面横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1));
   await page.screenshot({path:path.join(OUT,name+'-'+theme+'-'+width+'.png')});
   if(route==='/'){
    check('文档入口是本站指南',await page.locator('.studio-header a').filter({hasText:'文档'}).getAttribute('href')==='#quickstart');
    const catalog=await (await page.request.get(BASE+'/api/catalog')).json();
    check('首页厂商数量匹配真实注册表',await page.locator('.home-vendor').count()===catalog.data.providers.length);
    await page.getByRole('tab',{name:'选择模型与厂商'}).click();check('厂商标签页可切换',await page.locator('.home-provider-demo').isVisible());
    await page.getByRole('tab',{name:'掌握每一次调用'}).click();check('流程标签页可切换',await page.locator('.home-lifecycle').isVisible());
   }else if(route==='/admin/monitor'){
    for(const [label,tab] of [['系统资源','infra'],['渠道与流量','traffic'],['告警中心','alerts']]){
      await page.getByText(label,{exact:true}).click();await page.waitForTimeout(250);
      check('监控 '+label+' '+width+' 无溢出',await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1));
      if(width!==320)await page.screenshot({path:path.join(OUT,'monitor-'+tab+'-'+theme+'-'+width+'.png')});
    }
   }else{
    await page.getByText('7 天',{exact:true}).click();await page.waitForTimeout(350);
    check('日期选择刷新 7 天',await page.locator('.oo-dashboard-context').innerText().then(s=>s.includes('近 7 天')));
   }
  }
  await ctx.close();
 }
 const ctx=await browser.newContext({viewport:{width:1440,height:900}});
 await ctx.addInitScript(t=>localStorage.setItem('ooapi-token',t),token);
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE+'/console',{waitUntil:'networkidle'});
 await page.getByRole('link',{name:'接入指南'}).click();
 await page.waitForTimeout(300);
 check('从看板可跳到首页接入文档',await page.locator('#quickstart').evaluate(e=>location.hash === '#quickstart' && document.querySelector(".studio-window-scroll").scrollTop > 0 && e.getBoundingClientRect().top >= 0 && e.getBoundingClientRect().bottom <= innerHeight));
 await page.goto(BASE+'/console',{waitUntil:'networkidle'});
 const status=(await (await page.request.get(BASE+'/api/status')).json());
 let changed=false;
 await page.route('**/api/status',route=>{const body=structuredClone(status);if(!changed){body.data.build_id='index-new-version-test.js';changed=true;}return route.fulfill({json:body});});
 const topBefore=await page.locator('.oo-page-head').evaluate(e=>e.getBoundingClientRect().top);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.getByText('页面版本已更新',{exact:true}).waitFor();
 check('更新通知固定于右上角',await page.locator('.oo-update-notice').evaluate(e=>e.getBoundingClientRect().right > innerWidth - 60 && e.getBoundingClientRect().top < 100));
 check('通知不挤占页面内容',await page.locator('.oo-page-head').evaluate(e=>e.getBoundingClientRect().top)===topBefore);
 const progress=page.locator('.oo-update-progress i');
 const first=await progress.evaluate(e=>e.getBoundingClientRect().width);
 await page.waitForTimeout(1400);
 check('边框进度条随倒计时减少',await progress.evaluate(e=>e.getBoundingClientRect().width)<first);
 await page.screenshot({path:path.join(OUT,'update-notice.png')});
 await page.waitForEvent('load',{timeout:12000});
 check('十秒倒计时触发页面刷新',true);
 await page.waitForTimeout(600);check('刷新后无重复通知',await page.locator('.oo-update-notice').count()===0);
 await ctx.close();check('浏览器运行期错误为零',errors.length===0);
 console.log('UI review: '+checks+' checks; screenshots '+OUT);
}finally{await browser.close();await pool.end();}
process.exit(0);
