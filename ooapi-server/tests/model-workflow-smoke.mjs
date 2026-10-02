// 仅在隔离数据库运行；--seed 后重启候选服务，再不带参数执行 HTTP / 浏览器验收。
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import { chromium } from "playwright";
import { pool, JWT_SECRET } from "../src/db.js";
const BASE = process.env.BASE || "http://127.0.0.1:4115";
const [[database]] = await pool.query("SELECT DATABASE() name");
assert.equal(database.name, "ooapi_model_gate", "禁止在生产数据上创建测试夹具");
assert.equal(new URL(BASE).hostname, "127.0.0.1");
const group = "模型归属验收分组";
const sku = "mimo-v2.6-flash-free", model = "mimo-v2.6-flash";
const [[admin]] = await pool.query("SELECT * FROM users WHERE role>=100 LIMIT 1");
if (process.argv.includes("--seed")) {
  await pool.query("INSERT INTO users (id,username,password,role,status,quota,created_time) VALUES (901,'model-fixture-user','fixture-disabled-password',1,1,10000000,?) ON DUPLICATE KEY UPDATE quota=10000000", [Math.floor(Date.now()/1000)]);
  await pool.query("INSERT INTO channels (id,name,type,base_url,api_key,models,group_name,group_list,other,status) VALUES (101,?,'opencode','http://127.0.0.1:4116/v1','fixture',?,?,?, ?,1) ON DUPLICATE KEY UPDATE models=VALUES(models)", ["模型归属测试",sku+",unpriced-private-fixture",group,JSON.stringify([group]),JSON.stringify({method:"api",allow_private_upstream:true})]);
  await pool.query("INSERT INTO channel_groups (name,vendor,rate,models,remark) VALUES (?,'',0.5,?,?) ON DUPLICATE KEY UPDATE models=VALUES(models)", [group,JSON.stringify([sku,"unpriced-private-fixture"]),"分组宽度验收".repeat(40)]);
  for (const [id,user,key] of [[901,901,"fixture-user-key"],[902,admin.id,"fixture-admin-key"]]) await pool.query("INSERT INTO tokens (id,user_id,name,key_str,status,unlimited_quota,group_name) VALUES (?,?,?, ?,1,1,?) ON DUPLICATE KEY UPDATE group_name=VALUES(group_name)",[id,user,"归属验收密钥"+id,key,group]);
  await pool.query("DELETE FROM model_attributions WHERE alias=?",[sku]);
  await pool.end(); console.log("模型工作流夹具就绪，请重启隔离服务"); process.exit(0);
}
const [[user]] = await pool.query("SELECT * FROM users WHERE id=901");
const sign = u => jwt.sign({ id:u.id,role:u.role,tv:Number(u.token_version)||0 },JWT_SECRET,{expiresIn:"20m"});
const adminJwt=sign(admin), userJwt=sign(user);
let count=0;
const check=(condition,message)=>{assert.ok(condition,message);count++;};
async function request(path,{method="GET",body,token=adminJwt}={}) {
  const res=await fetch(BASE+path,{method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  const text=await res.text(); let data;try{data=JSON.parse(text)}catch{data=text}
  return {status:res.status,data:data?.data ?? data,raw:data};
}
let browser;
try {
  check((await request("/api/dashboard/filters",{token:userJwt})).status===403,"普通用户不能读取全站筛选维度");
  let pending=(await request("/api/pricing/attribution")).data;
  check(pending.models.some(m=>m.model===sku&&m.candidates.some(c=>c.model===model)),"免费后缀呈现候选");
  const before=(await pool.query("SELECT quota FROM users WHERE id=901"))[0][0].quota;
  for(const name of [sku,"unpriced-private-fixture","auto"]) {
    const r=await request("/v1/chat/completions",{method:"POST",token:"fixture-user-key",body:{model:name,messages:[{role:"user",content:"pong"}]}});
    check(r.status===400&&JSON.stringify(r.raw).includes("model_not_priced"),`未定价 ${name} 被拒绝`);
  }
  check(Number((await pool.query("SELECT quota FROM users WHERE id=901"))[0][0].quota)===Number(before),"拒绝请求不扣费");
  const approve={method:"POST",body:{alias:sku,model}};
  check((await request("/api/pricing/attribution",{...approve,token:userJwt})).status===403,"普通用户不能更改归属");
  check((await request("/api/pricing/attribution",approve)).status===200,"管理员确认归属");
  const list=(await request("/v1/models",{token:"fixture-user-key"})).data;
  check(list.length===1&&list[0].id===model,"API目录只展示已定价实际模型");
  const meta=(await request("/api/chat/meta?keyId=901",{token:userJwt})).data;
  check(meta.models.length===1&&meta.models[0].id===model&&meta.models[0].vendor==="mimo","对话目录和图标归小米");
  const groups=(await request("/api/token/groups",{token:userJwt})).data;
  check(groups.find(g=>g.name===group).models.join()===model,"密钥分组过滤未定价SKU");
  const completion=await request("/v1/chat/completions",{method:"POST",token:"fixture-user-key",body:{model,messages:[{role:"user",content:"pong"}],max_tokens:16}});
  check(completion.status===200&&completion.raw.choices?.[0]?.message?.content.includes("pong"),"归属后的真实请求成功");
  const session=(await request("/api/chat/sessions",{method:"POST",token:userJwt,body:{model:"unpriced-private-fixture"}})).data;
  check((await request("/api/chat/run",{method:"POST",token:userJwt,body:{sessionId:session.id,text:"hello",model:"unpriced-private-fixture",keyId:901}})).status===400,"站内对话不能调用未定价模型");
  const ordinary=(await request("/api/log/usage",{token:userJwt})).data.items;
  check(ordinary.some(r=>r.model===model&&r.model_vendor==="mimo"),"普通记录使用实际模型和图标");
  check(ordinary.every(r=>!Object.hasOwn(r,"original_model")&&!Object.hasOwn(r.billing_details||{},"channel_quote")),"原型号与渠道报价只下发管理员");
  const adminRows=(await request("/api/log/usage")).data.items;
  check(adminRows.some(r=>r.model===model&&r.original_model===sku),"管理员能追溯原始SKU");
  check(adminRows.some(r=>r.model===model&&r.billing_details?.channel_quote?.price?.in===0),"管理员原始渠道报价识别免费SKU");
  const [[totals]]=await pool.query("SELECT COUNT(*) calls,COALESCE(SUM(quota),0) units FROM logs WHERE user_id=901 AND token_id=901 AND is_usage=1");
  const dashboard=(await request("/api/dashboard/admin?user_id=901&token_id=901&range=7d")).data;
  check(dashboard.totals.calls===Number(totals.calls)&&dashboard.totals.units===Number(totals.units),"筛选后的总数和费用与SQL一致");
  check(dashboard.trend.reduce((n,d)=>n+d.units,0)===Number(totals.units),"筛选后的趋势与总计一致");
  check((await request(`/api/dashboard/admin?user_id=${admin.id}&token_id=901`)).status===400,"不匹配的用户密钥组合被拒绝");
  check((await request("/api/pricing/attribution",{method:"DELETE",body:{alias:sku}})).status===200,"撤销接口未被模型删除路由抢占");
  check((await request("/v1/models",{token:"fixture-user-key"})).data.length===0,"撤销后目录立即关闭");
  check((await request("/api/pricing/attribution",approve)).status===200,"再次确认恢复");

  browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.addInitScript(t=>localStorage.setItem("ooapi-token",t),adminJwt);
  const page=await ctx.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(BASE+"/console",{waitUntil:"networkidle"});
  check(await page.getByRole("combobox",{name:"筛选用户"}).count()===1,"管理员数据看板有用户筛选");
  check(await page.locator('a[href="/admin/dashboard"],a[href="/pricing"]').count()===0,"侧栏去掉重复看板和模型价格入口");
  await page.goto(BASE+"/admin/dashboard",{waitUntil:"networkidle"});check(new URL(page.url()).pathname==="/console","旧平台看板地址归并");
  await page.goto(BASE+"/pricing",{waitUntil:"networkidle"});check(new URL(page.url()).pathname==="/console","旧模型价格地址归并");
  await page.goto(BASE+"/token",{waitUntil:"networkidle"});
  await page.getByRole("button",{name:"创建令牌"}).click();
  const modal=page.locator('.ant-modal-content');
  await modal.locator('.ant-select').filter({has:page.locator('input[id$="group_name"]')}).click();
  const popup=page.locator('.ant-select-dropdown:visible');await popup.waitFor();
  const bounds=await modal.boundingBox(),dropdown=await popup.boundingBox();
  check(dropdown.x>=bounds.x-1&&dropdown.x+dropdown.width<=bounds.x+bounds.width+1,"密钥分组下拉不超过弹窗边缘");
  await fs.mkdir("/var/tmp/ooapi-model-evidence",{recursive:true});await page.screenshot({path:"/var/tmp/ooapi-model-evidence/token-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  const mobile=await popup.boundingBox();check(mobile.x>=0&&mobile.x+mobile.width<=391,"移动端下拉保持视口内");
  await page.screenshot({path:"/var/tmp/ooapi-model-evidence/token-mobile.png"});
  await page.keyboard.press("Escape"); await page.goto(BASE+"/log",{waitUntil:"networkidle"});
  check(await page.locator('.oo-model-origin').count()>0,"管理员记录显示原始SKU胶囊");
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.oo-billing-trigger').first().hover();
  const bill=page.locator('.oo-billing-details').first();await bill.waitFor();
  check(!/逐次调用|原始费用是三项|扣费按额度单位取整/.test(await bill.innerText()),"费用明细已精简");
  await page.screenshot({path:"/var/tmp/ooapi-model-evidence/billing.png"});
  await page.goto(BASE+"/admin/pricing",{waitUntil:"networkidle"});
  check(await page.getByText("比对归属",{exact:true}).count()>0,"管理员归属配置可用");
  check(errors.length===0,"浏览器无运行错误："+errors.join(","));
  console.log(`模型工作流 HTTP 与浏览器：${count} 项通过`);
} finally { await browser?.close(); await pool.end(); }
