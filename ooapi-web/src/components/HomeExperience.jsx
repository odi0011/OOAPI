import React, { useEffect, useState } from "react";
import { Button, Empty, Tag } from "antd";
import { ApiOutlined, ArrowRightOutlined, CheckOutlined, CodeOutlined, KeyOutlined, PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { VendorIcon } from "./VendorIcon";
import { StudioCat } from "./StudioUI";
import BrandLogo, { BrandName } from "./BrandLogo";
const STEPS = ["校验应用令牌", "检查模型权限", "路由至上游渠道", "返回响应，记录用量"];
export function ConnectionDemo({ endpoint, motion }) {
 const [step,setStep]=useState(0);
 useEffect(()=>{if(step>=4||!motion.active)return;const timer=setTimeout(()=>setStep(s=>s+1),850);return()=>clearTimeout(timer);},[step,motion.active]);
 return <div className="studio-demo home-protocol-demo" data-demo-motion={motion.active?'on':'off'}>
  <div className="studio-demo-toolbar"><span><i/><i/><i/></span><code>request.playground</code><Tag>流程演示</Tag></div>
  <div className="studio-request-map"><div className="studio-flow-end"><CodeOutlined/><span>你的应用</span></div><div className={`studio-flow-wire${step<4?' is-running':''}`}><i/><i/><i/></div><div className={`studio-flow-hub${step<4?' is-awake':''}`}><BrandLogo size={25}/><b><BrandName/></b></div><div className={`studio-flow-wire${step>=2&&step<4?' is-running':''}`}><i/><i/><i/></div><div className="studio-flow-end"><KeyOutlined/><span>上游渠道</span></div></div>
  <div className="studio-mini-terminal"><span>POST</span><code>{endpoint}/chat/completions</code><small>Authorization: Bearer your-api-key</small></div>
  <ol className="studio-request-steps" aria-live="off">{STEPS.map((label,i)=><li key={label} className={step>i?'is-done':step===i?'is-current':''}><span>{step>i?<CheckOutlined/>:`0${i+1}`}</span><b>{label}</b><small>{step>i?'完成':step===i?'演示中':'等待'}</small></li>)}</ol>
  <div className="studio-demo-bottom"><span>仅演示流程，不发送请求或产生费用</span><Button icon={step>=4?<ReloadOutlined/>:<PlayCircleOutlined/>} onClick={()=>setStep(motion.active?0:4)} disabled={step<4&&motion.active}>{step>=4?'再看一次':'播放接入流程'}</Button></div>
 </div>;
}
export function ProviderDemo({ providers,error,name,motion }) {
 const [selected,setSelected]=useState(0);const [manual,setManual]=useState(false);const nodes=(providers||[]).slice(0,6);const current=nodes[selected]||nodes[0];
 useEffect(()=>{if(!motion.active||manual||nodes.length<2)return;const timer=setTimeout(()=>setSelected(s=>(s+1)%nodes.length),2400);return()=>clearTimeout(timer);},[selected,motion.active,manual,nodes.length]);
 return <div className="studio-demo home-provider-demo" data-demo-motion={motion.active?'on':'off'}>
  <div className="studio-demo-toolbar"><span><i/><i/><i/></span><code>providers.directory</code><Tag>已集成</Tag></div>
  {nodes.length?<><div className="studio-network"><svg viewBox="0 0 600 320" preserveAspectRatio="none" aria-hidden="true"><g>{nodes.map((p,i)=>{const d=`M ${i<3?104:496} ${60+i%3*100} C ${i<3?230:370} ${60+i%3*100}, ${i<3?190:410} 160, 300 160`;return <g key={p.key}><path d={d}/><path d={d} pathLength="100" className={`studio-network-signal${selected===i?' is-active':''}`} style={{animationDelay:`${i*-.6}s`}}/></g>;})}</g></svg><div className="studio-network-center"><BrandLogo size={28}/><b>{name}</b><span>一个连接处</span></div>{nodes.map((p,i)=><button key={p.key} type="button" className={`studio-network-node node-${i}${selected===i?' is-selected':''}`} aria-pressed={selected===i} onClick={()=>{setSelected(i);setManual(true);}}><VendorIcon type={p.icon} size={25}/><b>{p.name}</b></button>)}</div><div className="studio-provider-detail" aria-live={manual?'polite':'off'}><div><VendorIcon type={current.icon} size={28}/><b>{current.name}</b></div><p>{current.methods.join(' · ')}</p><span>具体可用模型，以当前令牌与分组权限为准。</span></div></>:<div className="studio-demo-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error?'厂商目录暂时不可用':providers?'暂无已登记厂商':'正在读取厂商目录…'}/></div>}
 </div>;
}
export function UsageDemo({motion}) {
 const [selected,setSelected]=useState('input');const [manual,setManual]=useState(false);
 useEffect(()=>{if(!motion.active||manual)return;const timer=setTimeout(()=>setSelected(s=>s==='input'?'output':s==='output'?'cache':'input'),2500);return()=>clearTimeout(timer);},[selected,motion.active,manual]);
 const options={input:['输入 Token','发送给模型的内容，包含命中的缓存部分。'],output:['输出 Token','模型为这次请求生成的内容。'],cache:['缓存读取','已经包含在输入 Token 中，不会再次加进总量。']};
 return <div className="studio-demo home-lifecycle"><div className="studio-demo-toolbar"><span><i/><i/><i/></span><code>understand.your.usage</code><Tag>用量说明</Tag></div><div className="studio-receipt-wrap"><StudioCat pose="peek" className="studio-receipt-cat"/><div className="studio-receipt"><span>每次调用，都有来有回</span><h3>用量的每一部分，<br/>都说得清楚。</h3><div className="studio-token-parts">{Object.entries(options).map(([key,[label]])=><button key={key} type="button" aria-pressed={selected===key} onClick={()=>{setSelected(key);setManual(true);}} className={selected===key?'is-selected':''}>{label}<ArrowRightOutlined/></button>)}</div><p aria-live={manual?'polite':'off'} key={selected} className="studio-usage-explainer">{options[selected][1]}</p><div className="studio-receipt-total"><span>总 Token</span><b>输入 + 输出</b></div><small>实际用量与消费，请在登录后的使用记录中查看。</small></div></div></div>;
}
