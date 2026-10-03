// 仅允许隔离测试库；使用真实页面与数据库验证能力/价格的原子保存。
import 'dotenv/config';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:4255';
const {pool}=await import('../src/db.js');
const {signToken}=await import('../src/middleware/auth.js');
const {chromium}=await import('playwright');
const [[db]]=await pool.query('SELECT DATABASE() name');assert.equal(db.name,'ooapi_preset_gate');
await pool.query('INSERT IGNORE INTO channels (id,name,type,models,group_name,group_list,status) VALUES (?,?,?,?,?,?,?)',[3,'Price preset fixture','kiro','auto','测试','["测试"]',1]);
const [[admin]]=await pool.query('SELECT * FROM users WHERE role>=1000 AND status=1 LIMIT 1');const token=signToken(admin);
const headers={authorization:'Bearer '+token,'content-type':'application/json'};
const api=async(path,body)=>{const r=await fetch(base+'/api'+path,{headers,...(body?{method:'PUT',body:JSON.stringify(body)}:{})});const j=await r.json();assert(r.ok&&j.success!==false,`API failed ${r.status}: ${j.message}`);return j.data;};
const current=async()=>(await api('/pricing/capabilities?model=3-auto')).items[0];
const catalog=await api('/pricing/capabilities'),original=await current();assert(original);const sourcePrices=catalog.presets.map(p=>catalog.items.find(i=>i.model===p.model)?.pricing);
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];
 await page.addInitScript(t=>{localStorage.setItem('ooapi-token',t);localStorage.setItem('ooapi-color-mode','light');},token);
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/pricing/capabilities'))writes.push(r.postDataJSON());});
 await page.goto(base+'/admin/pricing',{waitUntil:'networkidle'});
 const open=async()=>{await page.getByRole('searchbox',{name:'搜索模型能力'}).fill('3-auto');await page.locator('.ant-table-row').filter({hasText:'3-auto'}).getByRole('button',{name:/配\s*置/}).click();await page.locator('.ant-drawer-open').waitFor();};
 const drawer=page.locator('.ant-drawer-content');
 const save=async()=>{try {const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/pricing/capabilities')),drawer.getByRole('button',{name:/^保\s*存$/}).click()]);assert(response.ok(),`Save failed ${response.status()}: ${(await response.json()).message}`);await page.locator('.ant-drawer-open').waitFor({state:'hidden'});}catch(error){console.log('Form errors:',await drawer.locator('.ant-form-item-explain-error').allTextContents(),'Messages:',await page.locator('.ant-message').allTextContents(),'Runtime:',errors,'Saves:',writes.length);await page.screenshot({path:'/var/tmp/ooapi-price-failure.png'});throw error;}};
 await open();
 for(const p of catalog.presets){
  await drawer.getByRole('button',{name:p.label,exact:true}).click();
  for(const k of ['input','output','cache'])assert.equal(Number(await drawer.locator('#price_'+k).inputValue()),p.pricing[k]);
  assert.equal(await drawer.getByLabel('上下文窗口',{exact:true}).inputValue(),String(p.capabilities.contextWindow));
  assert.equal(await drawer.getByRole('link',{name:'厂商文档'}).getAttribute('href'),'https://kiro.dev/docs/models/');
 }
 assert.equal(writes.length,0);
 await drawer.getByRole('button',{name:/取\s*消/}).click();await page.locator('.ant-drawer-open').waitFor({state:'hidden'});assert.deepEqual(await current(),original);
 console.log('PASS five presets fill capabilities/prices; cancelling changes neither');
 await open();await drawer.getByRole('button',{name:'DeepSeek Flash',exact:true}).click();
 await drawer.locator('#price_input').fill('0.456789');await drawer.getByLabel('上下文窗口',{exact:true}).fill('900000');
 await drawer.getByText('查看分档与分时价格',{exact:true}).click();await page.screenshot({path:'/var/tmp/ooapi-price-desktop.png'});
 await save();let stored=await current();assert.equal(stored.contextWindow,900000);assert.equal(stored.pricing.input,0.456789);assert.equal(stored.pricing.offpeakInput,0.15);assert.equal(stored.pricing.type,'kiro');
 const [[priceRow]]=await pool.query('SELECT input_price, channel_type FROM model_prices WHERE model=?',['3-auto']);assert.equal(Number(priceRow.input_price),0.456789);assert.equal(priceRow.channel_type,'kiro');
 const pending=await api('/pricing/pending');assert(!JSON.stringify(pending).includes('3-auto'));
 await page.getByRole('tab',{name:'价格与计费',exact:true}).click();await page.getByPlaceholder('搜索模型',{exact:true}).fill('3-auto');await page.getByPlaceholder('搜索模型',{exact:true}).press('Enter');
 await page.locator('.ant-tabs-tabpane-active .ant-table-row').filter({hasText:'3-auto'}).waitFor();
 await page.getByRole('tab',{name:'参数与能力',exact:true}).click();await open();assert.equal(Number(await drawer.locator('#price_input').inputValue()),0.456789);
 await drawer.locator('#price_input').fill('0.5');await save();stored=await current();assert.equal(stored.pricing.input,0.5);assert.equal(stored.pricing.offpeakInput,0.15);
 console.log('PASS manual override saved at six decimals; correct model/vendor; reopening and pricing tab refresh; existing rules retained');
 for(const id of ['gemini-3.8-flash','gpt-6.1-sol','claude-opus-5-5']){
  const p=catalog.presets.find(p=>p.model===id);await open();await drawer.getByRole('button',{name:p.label,exact:true}).click();await save();stored=await current();assert.deepEqual(stored.pricing.tiers,p.pricing.tiers);assert.equal(stored.pricing.offpeakRule,'');assert.equal(stored.pricing.input,p.pricing.input);
 }
 await open();await drawer.getByRole('button',{name:'GPT 6 Astra',exact:true}).click();await drawer.getByRole('checkbox',{name:'启用分档与分时价格'}).uncheck();await save();assert.deepEqual((await current()).pricing.tiers,[]);
 console.log('PASS switching presets replaces stale tiers/time schedules/offpeak rules; rules can be disabled');
 stored=await current();
 for(const price of [{input:-1,output:1,cache:0},{input:1,output:null,cache:0},{input:1,output:1,cache:0,presetModel:'missing'}]){
  const r=await fetch(base+'/api/pricing/capabilities',{method:'PUT',headers,body:JSON.stringify({model:'3-auto',capabilities:{...stored,notes:'must not save'},pricing:price})});assert.equal(r.status,400);assert.deepEqual(await current(),stored);
 }
 await pool.query("ALTER TABLE model_prices ADD CONSTRAINT fixture_price_failure CHECK (model <> '3-auto' OR input_price <> 12)");
 try{
  const r=await fetch(base+'/api/pricing/capabilities',{method:'PUT',headers,body:JSON.stringify({model:'3-auto',capabilities:{...stored,notes:'must roll back'},pricing:{input:12,output:34,cache:1}})});assert(r.status>=400);assert.deepEqual(await current(),stored);
  const [[row]]=await pool.query('SELECT value FROM options WHERE key_str=?',['model_caps:3-auto']);assert.equal(JSON.parse(row.value).notes,stored.notes);
 }finally{await pool.query('ALTER TABLE model_prices DROP CHECK fixture_price_failure');}
 console.log('PASS invalid prices and real MySQL price write failure leave capabilities, cache, and price unchanged');
 await api('/pricing/capabilities',{model:'3-auto',capabilities:stored,pricing:{input:0,output:0,cache:0,keepRules:false}});assert.equal((await current()).pricing.input,0);
 const final=await api('/pricing/capabilities');assert.deepEqual(final.presets.map(p=>final.items.find(i=>i.model===p.model)?.pricing),sourcePrices);
 await page.setViewportSize({width:390,height:844});await open();await drawer.getByRole('button',{name:'Gemini 3.8 Flash',exact:true}).click();
 for(const k of ['input','output','cache']){const box=await drawer.locator('#price_'+k).boundingBox();assert(box.x>=0&&box.x+box.width<=391);}
 await page.screenshot({path:'/var/tmp/ooapi-price-mobile.png'});await drawer.getByRole('button',{name:/取\s*消/}).click();
 assert.deepEqual(errors,[]);console.log('PASS explicit zero supported; source model prices unchanged; mobile fields fit; no runtime errors');
}finally{await browser.close();await pool.end();}
