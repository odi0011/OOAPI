// 首页交互与认证回归。只允许 localhost + 独立 ooapi_home_* 数据库，所有设置在 finally 恢复。
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { chromium } from 'playwright';
import { pool } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
const BASE=process.env.BASE || 'http://127.0.0.1:3012';
const [[db]]=await pool.query('SELECT DATABASE() AS name');
assert.ok(/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE) && /^ooapi_home_/.test(db.name),'必须使用本地隔离候选库');
const [[admin]]=await pool.query('SELECT id,role,token_version FROM users WHERE role >= 1000 LIMIT 1');
assert.ok(admin,'需要隔离库管理员');
const token=signToken(admin);
async function api(route,body){const r=await fetch(BASE+'/api'+route,{method:body?'PUT':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.ok(r.ok && d.success,'候选接口操作成功：'+route);return d.data;}
const keys=['password_register_enabled','password_login_enabled','password_min_length','register_email_required','register_invite_only'];
const opts=await api('/option');const saved=Object.fromEntries(keys.map(k=>[k,opts[k]]));
const suffix=crypto.randomBytes(5).toString('hex');const username='studio_'+suffix;const newcomer='studio_new_'+suffix;
const legacyPassword=crypto.randomBytes(4).toString('hex');const password=crypto.randomBytes(16).toString('hex')+'!';
const invite=crypto.randomBytes(8).toString('hex');const email='studio-'+suffix+'@example.invalid';
const ids=[];let checks=0;const errors=[];
const check=(label,condition)=>{assert.ok(condition,label);checks++;console.log('  ok '+label);};
let browser;
try {
 const [ret]=await pool.query('INSERT INTO users (username,password,display_name,role,status,aff_code,created_time,group_name) VALUES (?,?,?,1,1,?,?,?)',[username,await bcrypt.hash(legacyPassword,10),'UI synthetic',invite,Date.now(), '']);ids.push(ret.insertId);
 await api('/option',{password_register_enabled:'true',password_login_enabled:'true',password_min_length:'12',register_email_required:'true',register_invite_only:'true'});
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE+'/token?from=studio#owned',{waitUntil:'networkidle'});
 await page.getByRole('tab',{name:'注册',exact:true}).click();
 check('注册读取邮箱与邀请配置',await page.locator('#register_email').count()===1 && await page.locator('#register_invite_code').count()===1);
 await page.locator('#register_username').fill(newcomer);await page.locator('#register_email').fill(email);await page.locator('#register_invite_code').fill(invite);
 await page.locator('#register_password').fill(legacyPassword);await page.locator('#register_confirm').fill(legacyPassword);
 let registrations=0;page.on('request',r=>{if(r.url().endsWith('/api/user/register') && r.method()==='POST')registrations++;});
 await page.locator('.studio-auth-submit').click();
 await page.getByText('密码至少 12 位',{exact:true}).waitFor();check('设置要求的密码长度在提交前校验',registrations===0);
 await page.locator('#register_password').fill(password);await page.locator('#register_confirm').fill(password+'x');
 await page.locator('.studio-auth-submit').click();await page.getByText('两次密码不一致',{exact:true}).waitFor();check('确认密码不匹配时不发送注册',registrations===0);
 await page.locator('#register_confirm').fill(password);
 check('密码输入时小猫闭眼',await page.locator('.auth-mascot img').getAttribute('src')==='/illustrations/cat-doze.webp');
 await page.locator('.studio-auth-submit').click();await page.waitForURL('**/token?from=studio#owned');
 check('注册成功保留原路由、查询串与锚点',new URL(page.url()).hash==='#owned');
 const [[created]]=await pool.query('SELECT id,email,inviter_id FROM users WHERE username=?',[newcomer]);check('邮箱和邀请码真实保存',created?.email===email && created?.inviter_id===ids[0]);if(created)ids.push(created.id);
 await ctx.close();
 const loginCtx=await browser.newContext();const loginPage=await loginCtx.newPage();loginPage.on('pageerror',e=>errors.push(e.message));
 await loginPage.goto(BASE+'/token?from=studio#owned',{waitUntil:'networkidle'});await loginPage.locator('#login_username').fill(username);await loginPage.locator('#login_password').fill(password);
 await loginPage.locator('.studio-auth-submit').click();await loginPage.locator('.studio-auth-fields .ant-alert-error').waitFor();check('错误凭据在表单内明确提示',true);
 await loginPage.locator('#login_password').fill(legacyPassword);await loginPage.locator('.studio-auth-submit').click();await loginPage.waitForURL('**/token?from=studio#owned');check('旧账号短密码仍可登录且正确返回',true);await loginCtx.close();
 await api('/option',{password_register_enabled:'false',password_login_enabled:'false'});
 const closedCtx=await browser.newContext();const closedPage=await closedCtx.newPage();
 for(const [route,label] of [['/register','暂未开放注册'],['/login','密码登录暂未开放']]){await closedPage.goto(BASE+route,{waitUntil:'networkidle'});check(label,await closedPage.getByText(label,{exact:true}).isVisible() && await closedPage.locator('form').count()===0);}
 await closedPage.route('**/api/status',r=>r.fulfill({status:503,json:{success:false,message:'synthetic unavailable'}}));await closedPage.reload({waitUntil:'networkidle'});check('站点设置不可用可重试且不展示可提交表单',await closedPage.getByText('暂时无法读取登录设置',{exact:true}).isVisible() && await closedPage.locator('form').count()===0);await closedCtx.close();
 await api('/option',saved);
 const homeCtx=await browser.newContext({viewport:{width:1440,height:1000}});const home=await homeCtx.newPage();home.on('pageerror',e=>errors.push(e.message));let upstreamRequests=0;home.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/'))upstreamRequests++;});
 await home.goto(BASE,{waitUntil:'networkidle'});await home.getByRole('button',{name:'和小猫打个招呼'}).click();check('猫咪点击回应',await home.locator('.studio-companion-bubble.is-speaking').isVisible());
 const originalWidth=await home.locator('.studio-window').evaluate(e=>e.getBoundingClientRect().width);await home.getByRole('button',{name:'展开窗口'}).click();await home.waitForTimeout(650);check('桌面窗口可展开',await home.locator('.studio-window').evaluate(e=>e.getBoundingClientRect().width)>originalWidth);await home.getByRole('button',{name:'还原窗口'}).click();await home.waitForTimeout(650);
 await home.getByRole('button',{name:'关闭首页窗口'}).click();await home.getByText('首页窗口已收起',{exact:true}).waitFor();check('关闭窗口后可回到桌面',await home.locator('.studio-window.is-closed').count()===1);await home.getByRole('button',{name:'重新打开首页'}).click();
 await home.keyboard.press('Control+k');await home.getByPlaceholder('搜索文档、模型、令牌、用量…').fill('令牌');check('快捷搜索可以找到真实页面',await home.locator('.studio-search-results').getByText('API 令牌',{exact:true}).isVisible());await home.keyboard.press('Escape');
 await home.locator('#products').scrollIntoViewIfNeeded();await home.locator('.studio-request-steps li.is-done').nth(3).waitFor();check('演示完整经过四个步骤且不调用付费接口',upstreamRequests===0);
 await home.getByRole('button',{name:'暂停动效'}).click();check('可暂停所有持续动效',await home.locator('.studio').getAttribute('data-motion')==='off' && await home.locator('.studio-flow-wire i').first().evaluate(e=>getComputedStyle(e).animationPlayState)==='paused');
 await home.getByRole('tab',{name:'连接你的应用'}).focus();await home.keyboard.press('ArrowRight');check('标签支持键盘切换',await home.getByRole('tab',{name:'选择模型与厂商'}).getAttribute('aria-selected')==='true');
 const second=home.locator('.studio-network-node').nth(1);const providerName=await second.innerText();await second.click();check('点击厂商展示对应真实详情',(await home.locator('.studio-provider-detail').innerText()).includes(providerName));
 await home.getByRole('tab',{name:'查看调用用量'}).click();await home.getByRole('button',{name:'缓存读取',exact:false}).click();check('缓存用量说明不重复累计',await home.getByText('已经包含在输入 Token 中，不会再次加进总量。',{exact:true}).isVisible());
 await home.locator('#quickstart').scrollIntoViewIfNeeded();await home.getByText('cURL',{exact:true}).click();const command=await home.locator('.qs-code').innerText();check('接入示例包含真实地址与授权头',command.includes('/v1/models') && command.includes('Authorization: Bearer $OOAPI_API_KEY') && !command.includes('\n+'));
 await homeCtx.close();
 const reduced=await browser.newContext({reducedMotion:'reduce',viewport:{width:390,height:844}});const reducedPage=await reduced.newPage();await reducedPage.goto(BASE,{waitUntil:'networkidle'});check('遵循系统减少动态效果设置',await reducedPage.locator('.studio').getAttribute('data-motion')==='off');await reducedPage.getByRole('button',{name:'播放接入流程'}).click();check('减少动效模式仍可查看完整流程',await reducedPage.locator('.studio-request-steps li.is-done').count()===4);
 const images=await reducedPage.evaluate(async()=>{const items=[...document.images].filter(e=>{const r=e.getBoundingClientRect();return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight;});await Promise.all(items.map(i=>i.decode().catch(()=>{})));return items.every(i=>i.naturalWidth>0);});check('手机当前视口素材均可加载',images);
 await reduced.close();check('认证与互动无运行期错误',errors.length===0);console.log(`Studio UI ${checks}/${checks} passed`);
} finally {
 await browser?.close();await api('/option',saved).catch(()=>{console.error('恢复候选设置失败');process.exitCode=1;});
 const [owned]=await pool.query('SELECT id FROM users WHERE username IN (?,?)',[username,newcomer]);
 for(const {id} of owned){await pool.query('DELETE FROM logs WHERE user_id=?',[id]);await pool.query('DELETE FROM users WHERE id=?',[id]);}
 await pool.end();
}
