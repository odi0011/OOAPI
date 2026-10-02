import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiOutlined, ArrowRightOutlined, CheckOutlined, CodeOutlined, KeyOutlined, MessageOutlined, ThunderboltOutlined, SyncOutlined } from '@ant-design/icons';
import { fmtOd } from '../services/format';
import '../studio-bento.css';
import BrandLogo, { BrandName } from './BrandLogo';

function BentoCard({children,className='',motion}) {
 return <article className={`studio-bento-card ${className}`} onPointerMove={e=>{
  if(!motion.active||e.pointerType==='touch')return;const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  e.currentTarget.style.setProperty('--pointer-x',`${x*100}%`);e.currentTarget.style.setProperty('--pointer-y',`${y*100}%`);e.currentTarget.style.setProperty('--tilt-x',`${(y-.5)*-3}deg`);e.currentTarget.style.setProperty('--tilt-y',`${(x-.5)*3}deg`);
 }} onPointerLeave={e=>{e.currentTarget.style.setProperty('--tilt-x','0deg');e.currentTarget.style.setProperty('--tilt-y','0deg');}}>{children}</article>;
}
const DEMO_USAGE=[22,38,31,52,43,71,62,48,81,69,93,77,65,87];
export default function StudioBento({motion,onCompanionChange}) {
 const [protocol,setProtocol]=useState(0);const [keyApp,setKeyApp]=useState(0);const [bar,setBar]=useState(10);const [style,setStyle]=useState(0);
 const styles=[['wave','招手'],['stretch','伸懒腰'],['read','看书'],['sit','歪头'],['doze','打盹'],['listen','听音乐'],['teach','插画'],['friends','兔兔搭档']];
 return <section className="studio-section studio-bento-section" id="workspace" data-reveal>
  <div className="studio-bento-heading"><span className="studio-eyebrow">EXPLORE THE WORKSPACE</span><h2>工作台功能预览</h2><p>试试协议切换、应用令牌和用量图表。</p><span className="studio-demo-label">交互演示 · 以下数值为示例</span></div>
  <div className="studio-bento-layout">
   <BentoCard className="bento-connect" motion={motion}><div className="bento-copy"><ApiOutlined/><h3>三种兼容协议</h3><p>支持 OpenAI 与 Anthropic 格式。</p></div>
    <div className="bento-protocol-visual"><div className="bento-protocol-tabs">{['Chat Completions','Messages','Responses'].map((v,i)=><button key={v} className={protocol===i?'is-active':''} onClick={()=>setProtocol(i)}>{v}</button>)}</div><div className="bento-orbit-lines" aria-hidden="true"><i/><i/><i/></div><div className="bento-connector"><span><CodeOutlined/></span><i/><b><BrandLogo size={22}/> <BrandName/></b><i/><span><ThunderboltOutlined/></span></div><div className="bento-terminal" key={protocol}><span><i/><i/><i/><b>hello-api.js</b></span><code><em>await</em> client.{['chat.completions','messages','responses'][protocol]}.create({'{'})<br/>&nbsp; <small>model:</small> <strong>"your-model"</strong>,<br/>&nbsp; <small>{protocol===2?'input':'messages'}:</small> <strong>"你好，请介绍一下你自己。"</strong><br/>{'}'});</code><div><CheckOutlined/> 请求已完成 <span>演示</span><b>200 OK</b></div></div></div><Link to="/#quickstart" className="bento-link">接入指南 <ArrowRightOutlined/></Link>
   </BentoCard>
   <BentoCard className="bento-keys" motion={motion}><div className="bento-copy"><KeyOutlined/><h3>独立应用令牌</h3><p>分别设置应用额度和可用模型。</p></div><div className="bento-key-scene"><div className="bento-key-halo"/><img src="/illustrations/cat-key.webp" alt="小猫保管应用钥匙" loading="lazy"/><div className="bento-key-cards">{['个人实验室','我的应用','团队项目'].map((v,i)=><button key={v} className={keyApp===i?'is-active':''} onClick={()=>setKeyApp(i)} style={{'--card-index':i}}><span><KeyOutlined/><b>{v}</b><i>{keyApp===i?'已选中':'示例'}</i></span><code>oo_demo_••••••••</code><div><i style={{width:`${[32,68,45][i]}%`}}/></div><small>可独立设置额度与模型范围</small></button>)}</div></div><Link to="/token" className="bento-link">管理应用令牌 <ArrowRightOutlined/></Link></BentoCard>
   <BentoCard className="bento-chat" motion={motion}><div className="bento-copy"><MessageOutlined/><h3>在线对话</h3><p>支持附件、工具调用和多轮对话。</p></div><div className="bento-chat-visual" aria-label="示例对话"><div className="bento-chat-bubble chat-question">帮我检查这段接口代码。<span>你</span></div><div className="bento-chat-bubble chat-answer"><img src="/illustrations/cat-peek.webp" alt=""/><div><b>请贴上代码和报错信息。</b><span/><span/><span/></div></div><div className="bento-tool-pills"><span><CodeOutlined/> 代码</span><span><ApiOutlined/> 接口</span><span><CheckOutlined/> 计划就绪</span></div></div><Link to="/chat" className="bento-link">打开对话工作台 <ArrowRightOutlined/></Link></BentoCard>
   <BentoCard className="bento-analytics" motion={motion}><div className="bento-copy"><ThunderboltOutlined/><h3>用量统计</h3><p>按时间查看 Token 用量和消费。</p></div><div className="bento-chart"><div className="bento-chart-metrics"><div><span>示例用量</span><b>128.4<small>K</small></b></div><div><span>示例消费</span><b>{fmtOd(320,10000,3)}</b></div></div><div className="bento-chart-bars" role="group" aria-label="示例用量图">{DEMO_USAGE.map((v,i)=><button key={i} style={{'--bar-size':`${v}%`,'--bar-delay':`${i*45}ms`}} aria-label={`示例第 ${i+1} 天：${v}K Token`} className={bar===i?'is-active':''} onMouseEnter={()=>setBar(i)} onFocus={()=>setBar(i)}><span/></button>)}</div><div className="bento-chart-axis"><span>01</span><b>第 {bar+1} 天 · {DEMO_USAGE[bar]}K Token</b><span>14</span></div></div><Link to="/console" className="bento-link">打开数据看板 <ArrowRightOutlined/></Link></BentoCard>
   <BentoCard className="bento-companion" motion={motion}><div className="bento-copy"><h3>桌面小猫</h3><p>点击切换动作和画风。</p></div><div className="bento-mascot-stage" key={style}><div/><img src={`/illustrations/cat-${styles[style][0]}.webp`} alt={styles[style][1]} loading="lazy"/><span>✦</span><i>✧</i></div><button className="bento-style-switch" onClick={()=>{const next=(style+1)%styles.length;setStyle(next);onCompanionChange(styles[next][0]);}}><SyncOutlined/> {styles[style][1]} <span>换一个</span></button></BentoCard>
  </div>
 </section>;
}
