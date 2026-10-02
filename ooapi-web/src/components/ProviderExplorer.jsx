import React, { useMemo, useState } from 'react';
import { Input, Empty } from 'antd';
import { SearchOutlined, ArrowRightOutlined, CheckOutlined } from '@ant-design/icons';
import { VendorIcon } from './VendorIcon';
const FILTERS=[['all','全部'],['api','API 接入'],['web','网页会话'],['tools','工具与订阅']];
function matches(provider,type){if(type==='all')return true;return provider.methods.some(m=>type==='api'?/API|兼容/.test(m):type==='web'?/网页|系统驱动/.test(m):!/API|兼容|网页|系统驱动/.test(m));}
export default function ProviderExplorer({providers=[]}){
 const [query,setQuery]=useState('');const [filter,setFilter]=useState('all');const [selected,setSelected]=useState(providers[0]?.key);
 const items=useMemo(()=>providers.filter(p=>matches(p,filter)&&`${p.name} ${p.key} ${p.methods.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())),[providers,query,filter]);
 const current=items.find(p=>p.key===selected)||items[0];
 return <section className="studio-section studio-ecosystem" id="providers" data-reveal>
  <div className="studio-section-heading"><div><span className="studio-eyebrow">MODEL PROVIDERS</span><h2>已集成厂商</h2></div><span className="studio-count-label"><b>{providers.length}</b> 个已集成厂商</span></div>
  <div className="studio-provider-explorer">
   <div className="studio-provider-picker"><Input className="studio-provider-search" prefix={<SearchOutlined/>} value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索厂商或接入方式" allowClear aria-label="搜索厂商"/><div className="studio-provider-filters" role="group" aria-label="厂商接入方式">{FILTERS.map(([key,label])=><button key={key} type="button" aria-pressed={key===filter} onClick={()=>setFilter(key)}>{label}<span>{providers.filter(p=>matches(p,key)).length}</span></button>)}</div><div className="studio-provider-choices" aria-label="厂商列表">{items.length?items.map(p=><button className={`home-vendor studio-provider-choice${current?.key===p.key?' is-selected':''}`} key={p.key} type="button" aria-pressed={current?.key===p.key} onClick={()=>setSelected(p.key)}><VendorIcon type={p.icon} size={25}/><b>{p.name}</b>{current?.key===p.key&&<CheckOutlined/>}</button>):<Empty description="没有匹配的厂商" image={Empty.PRESENTED_IMAGE_SIMPLE}/>}</div><span className="studio-provider-found">{query||filter!=='all'?`${items.length} 个匹配结果`:'点击厂商，查看实际集成的接入方式'}</span></div>
   <div className="studio-provider-inspector" aria-live="polite">{current?<div key={current.key}><div className="studio-provider-emblem"><span/><VendorIcon type={current.icon} size={51}/></div><span className="studio-eyebrow">{current.key}</span><h3>{current.name}</h3><div className="studio-provider-methods">{current.methods.map(m=><span key={m}>{m}</span>)}</div><p>接入方式来自平台厂商注册表。<br/>可用模型以账户分组与令牌权限为准。</p><a className="studio-text-link" href="#quickstart">查看接入步骤 <ArrowRightOutlined/></a></div>:<div className="studio-provider-no-selection">没有匹配的厂商。</div>}</div>
  </div>
 </section>;
}
