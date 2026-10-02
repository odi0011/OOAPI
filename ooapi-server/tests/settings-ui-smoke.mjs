// 隔离候选库的真实浏览器验收：管理员保存、普通用户权限、桌面/移动端。
import "dotenv/config";
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import crypto from 'node:crypto';
import {chromium} from 'playwright';
const base=process.env.BASE || 'http://127.0.0.1:4105',dir=process.env.SETTINGS_REVIEW_SCREENSHOTS || '/var/tmp/ooapi-settings-review-evidence';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Settings review requires an isolated loopback candidate');
const {pool}=await import('../src/db.js'),{signToken}=await import('../src/middleware/auth.js');
const [[db]]=await pool.query('SELECT DATABASE() name');assert.match(db.name,/^ooapi_.*gate$/, 'Settings review requires an isolated gate database');
const [[admin]]=await pool.query('SELECT id,role,token_version FROM users WHERE role>=100 LIMIT 1');
const [normalResult]=await pool.query('INSERT INTO users (username,password,role,status,quota,used_quota,request_count,created_time) VALUES (?,?,1,1,987654,123456,12,?)',['settings_review_'+crypto.randomBytes(5).toString('hex'),'!disabled-fixture-login',Math.floor(Date.now()/1000)]);
const normal={id:normalResult.insertId,role:1,token_version:0};
const token=signToken(admin),normalToken=signToken(normal);
await fs.mkdir(dir,{recursive:true,mode:0o700});let checks=0;const errors=[];const check=(v,m)=>{assert(v,m);checks++;};
const api=async(path,{body,method='GET',auth=token}={})=>{const res=await fetch(base+'/api'+path,{method,headers:{Authorization:'Bearer '+auth,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await res.json();return {status:res.status,...j};};
const originalOptions=(await api('/option/')).data;
const restoreKeys=['user_data_visibility','default_theme','theme_font_family'];
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1560,height:980}});await context.addInitScript(t=>localStorage.setItem('ooapi-token',t),token);
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{errors.push('native dialog');d.dismiss()});
const screenshot=async(name)=>{await page.waitForTimeout(350);await page.screenshot({path:dir+'/'+name+'.png',fullPage:true});};
try{
 await page.goto(base+'/admin/settings?tab=appearance',{waitUntil:'networkidle'});await page.getByText('全站外观',{exact:true}).waitFor();
 check(await page.locator('.oo-sider').getByText('外观设置',{exact:true}).count()===0,'no separate appearance navigation');
 check(await page.getByRole('radiogroup',{name:'主题模式'}).count()===0,'no personal theme toggle');
 await screenshot('appearance-desktop');
 const initial=await page.evaluate(()=>document.documentElement.dataset.theme);
 await page.getByText(initial==='dark'?'浅色':'深色',{exact:true}).click();await page.waitForTimeout(180);
 check(await page.evaluate(()=>document.documentElement.dataset.theme)!==initial,'theme draft previews');
 await page.getByRole('tab',{name:'计费',exact:false}).click();await page.locator('.oo-admin-fixed-currency').waitFor();
 check(await page.evaluate(()=>document.documentElement.dataset.theme)===initial,'leaving tab restores saved theme');
 check(await page.locator('input[id*=currency_symbol]').count()===0,'currency is not editable text');
 check(await page.locator('.oo-admin-fixed-currency svg').count()>0,'unified currency SVG');await screenshot('billing-desktop');
 for(const [name,key] of [['站点','site'],['认证','auth'],['用户','user'],['安全','security'],['网关','gateway'],['邮件','email'],['备份','backup']]){
  await page.getByRole('tab',{name,exact:false}).click();await page.locator('.oo-admin-settings-form').waitFor();await screenshot('settings-'+key);
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),key+' no horizontal overflow');
 }
 await page.getByRole('tab',{name:'外观',exact:false}).click();await page.getByText('全站外观',{exact:true}).waitFor();
 await page.getByText('深色',{exact:true}).click();await page.locator('.oo-site-appearance-row').filter({has:page.getByText('界面字体',{exact:true})}).locator('.ant-select-selector').click();await page.locator('.ant-select-dropdown').getByText('系统字体',{exact:true}).click();
 await page.getByRole('button',{name:/保存外观/}).click();await page.getByText('外观已保存，全站生效',{exact:true}).waitFor();
 await page.reload({waitUntil:'networkidle'});check(await page.evaluate(()=>document.documentElement.dataset.theme)==='dark','saved mode survives reload');check(await page.evaluate(()=>document.documentElement.dataset.fontFamily)==='system','saved font survives reload');await screenshot('appearance-dark');
 const nc=await browser.newContext({viewport:{width:1440,height:900}});await nc.addInitScript(t=>{localStorage.setItem('ooapi-token',t);localStorage.setItem('ooapi-theme','light');localStorage.setItem('ooapi-primary','#ff0000');localStorage.setItem('ooapi-radius','round');},normalToken);
 const np=await nc.newPage();np.on('pageerror',e=>errors.push(e.message));await np.goto(base+'/settings/appearance',{waitUntil:'networkidle'});
 check(np.url().endsWith('/console'),'ordinary old appearance URL redirects');check(await np.evaluate(()=>document.documentElement.dataset.theme)==='dark','ordinary legacy personal preference ignored');
 check((await api('/option/',{method:'PUT',auth:normalToken,body:{default_theme:'light'}})).status===403,'ordinary users cannot save site appearance');
 await page.getByText('浅色',{exact:true}).click();await page.getByRole('button',{name:/保存外观/}).click();await page.getByText('外观已保存，全站生效',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'用户',exact:false}).click();await page.locator('.oo-admin-visibility-row').first().waitFor();
 check(await page.locator('.oo-admin-visibility-row').count()===5,'five explicit visibility controls');
 const rows=page.locator('.oo-admin-visibility-row');for(let i=0;i<5;i++){const sw=rows.nth(i).getByRole('switch');if(await sw.isEnabled()&&await sw.getAttribute('aria-checked')==='true')await sw.click();}
 await screenshot('visibility-desktop');await page.getByRole('button',{name:/保存.*设置/}).click();await page.getByText(/已保存/).last().waitFor();
 const policy=(await api('/status',{auth:normalToken})).data.user_data_visibility;check(['balance','usage_summary','usage_records','request_content','pricing'].every(k=>policy[k]===false),'saved field policy');
 const self=(await api('/user/self',{auth:normalToken})).data;check(!('quota' in self)&&!('used_quota' in self),'self API suppresses hidden balance and summary');
 for(const path of ['/log/usage','/log/usage/filters','/log/usage/summary','/pricing'])check((await api(path,{auth:normalToken})).status===403,path+' cannot bypass policy');
 await np.reload({waitUntil:'networkidle'});check(await np.getByText('可用余额',{exact:true}).count()===0,'balance not replaced by fake zero');check(await np.getByText('累计消费',{exact:true}).count()===0,'summary hidden');
 for(const path of ['/log','/pricing','/token','/profile','/chat']){await np.goto(base+path,{waitUntil:'networkidle'});check(await np.locator('#root').innerText()!=='','restricted page renders '+path);await np.screenshot({path:dir+'/ordinary-'+path.slice(1)+'.png'});}
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/admin/settings?tab=user',{waitUntil:'networkidle'});await screenshot('visibility-mobile');check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'mobile visibility fits');
 await page.goto(base+'/admin/settings?tab=appearance',{waitUntil:'networkidle'});await screenshot('appearance-mobile');check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'mobile appearance fits');
 await page.goto(base+'/admin/settings?tab=billing',{waitUntil:'networkidle'});await screenshot('billing-mobile');check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'mobile billing fits');
 check(errors.length===0,'no runtime errors or native dialogs');console.log(JSON.stringify({checks,errors,dir}));await nc.close();
}catch(e){await page.screenshot({path:dir+'/failure.png',fullPage:true});console.error(JSON.stringify({url:page.url(),checks,errors}));throw e;}finally{await api('/option/',{method:'PUT',body:Object.fromEntries(restoreKeys.map(k=>[k,originalOptions[k]]))});await browser.close();await pool.query('DELETE FROM users WHERE id=?',[normal.id]);await pool.end();}
