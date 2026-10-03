import React, { useEffect, useRef, useState } from "react";
import { App, Alert, Button, Checkbox, Input, InputNumber, Select, Space, Switch } from "antd";
import { API } from "../services/api";
import { chatApi } from "../services/chat";
import PageHeader from "../components/PageHeader";
import ChatMascot from "../components/ChatMascot";
import AgentTrajectory from "../components/AgentTrajectory";
import "../components/chat-workspace.css";
import "../components/agent-flow.css";

const toolNames = { account:"我的账号",binance:"币安分析",search:"联网检索",fetch:"读取网页",github:"GitHub",task:"子任务",todowrite:"任务清单" };
const kinds = { input:"开始",context:"上下文",model:"模型",tools:"能力",answer:"完成" };
export default function AgentFlowPage() {
  const { message } = App.useApp();
  const [flow,setFlow]=useState(null),[selected,setSelected]=useState("model"),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const [preview,setPreview]=useState(""),[sessions,setSessions]=useState([]),[sessionId,setSessionId]=useState(""),[messages,setMessages]=useState([]),[traceLoading,setTraceLoading]=useState(false);
  const drag=useRef(null), timers=useRef([]), viewport=useRef(null);
  const [zoom,setZoom]=useState(1);
  const fit=()=>setZoom(Math.min(1,Math.max(.3,((viewport.current?.clientWidth || 920)-2)/920)));
  useEffect(()=>{if(!flow||!viewport.current)return;const observer=new ResizeObserver(fit);observer.observe(viewport.current);return()=>observer.disconnect();},[Boolean(flow)]);
  useEffect(()=>{let live=true;Promise.all([API.get("/chat/flow"),chatApi.listSessions()]).then(([f,s])=>{if(live){setFlow(f);setSessions(Array.isArray(s)?s:s.items||s.sessions||[]);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;timers.current.forEach(clearTimeout);};},[]);
  useEffect(()=>{let live=true;if(!sessionId){setMessages([]);return;}setTraceLoading(true);chatApi.getSession(sessionId).then(r=>{if(live)setMessages(r.messages||[]);}).catch(e=>{if(live)message.error(e.message);}).finally(()=>{if(live)setTraceLoading(false);});return()=>{live=false;};},[sessionId,message]);
  const node=flow?.nodes.find(n=>n.id===selected);
  const patch=changes=>setFlow(f=>({...f,nodes:f.nodes.map(n=>n.id===selected?{...n,...changes}:n)}));
  const config=changes=>patch({config:{...node.config,...changes}});
  const save=async()=>{setSaving(true);try{setFlow(await API.put("/chat/flow",flow));message.success("编排已保存，下一轮对话生效");}catch(e){message.error(e.message);}finally{setSaving(false);}};
  const demo=()=>{timers.current.forEach(clearTimeout);const sequence=["input","memory","model",...(flow.edges.some(e=>e.to==="tools")?["tools","model"]:[]),"answer",""];sequence.forEach((id,i)=>timers.current.push(setTimeout(()=>setPreview(id),i*1100)));};
  if(error)return <Alert type="error" message={error}/>;
  if(!flow)return <div className="oo-page" aria-busy="true">正在读取编排…</div>;
  const toolConnected=flow.edges.some(e=>e.to==="tools");
  return <div className="oo-page"><PageHeader title="乐乐的工作室" description="把记忆、思考和工具连接起来。" extra={<Space><Button onClick={demo}>轨迹演示</Button><Button type="primary" loading={saving} onClick={save}>保存编排</Button></Space>}/>
    <div className="agent-flow-layout">
      {/* Beautiful UI Flowchart：点阵画布、圆角节点、曲线连接与选中态，适配本站语义主题。 */}
      <div><div className="agent-flow-zoom"><Button size="small" aria-label="缩小画布" onClick={()=>setZoom(z=>Math.max(.3,z-.1))}>−</Button><span>{Math.round(zoom*100)}%</span><Button size="small" aria-label="放大画布" onClick={()=>setZoom(z=>Math.min(1.5,z+.1))}>+</Button><Button size="small" onClick={fit}>适合窗口</Button></div><div ref={viewport} className="agent-flow-scroll"><div style={{width:920*zoom,height:780*zoom}}><div className="agent-flow-canvas" style={{transform:`scale(${zoom})`,transformOrigin:"0 0"}} aria-label="智能体能力编排画布">
        <svg className="agent-flow-edges" width="920" height="780" aria-hidden="true">{flow.edges.map(e=>{const a=flow.nodes.find(n=>n.id===e.from),b=flow.nodes.find(n=>n.id===e.to);const reverse=a.y>b.y;return <path key={`${e.from}:${e.to}`} className={preview===e.from||preview===e.to?"is-active":""} d={reverse?`M ${a.x-125} ${a.y+62} C ${a.x-245} ${a.y+62}, ${b.x+255} ${b.y+62}, ${b.x+125} ${b.y+62}`:`M ${a.x} ${a.y+95} C ${a.x} ${a.y+145}, ${b.x} ${b.y-45}, ${b.x} ${b.y+25}`}/>;})}</svg>
        {flow.nodes.map(n=><div className={`agent-flow-node ${selected===n.id?"is-selected":""} ${preview===n.id?"is-active":""}`} key={n.id} style={{left:n.x,top:n.y}}>
          <span className="agent-flow-kind">{kinds[n.kind]}</span>
          <button type="button" aria-pressed={selected===n.id} onClick={()=>setSelected(n.id)} onPointerDown={e=>{if(e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);setSelected(n.id);drag.current={id:n.id,x:e.clientX,y:e.clientY,startX:n.x,startY:n.y};}} onPointerMove={e=>{const d=drag.current;if(!d||d.id!==n.id)return;setFlow(f=>({...f,nodes:f.nodes.map(v=>v.id===d.id?{...v,x:Math.max(140,Math.min(770,d.startX+(e.clientX-d.x)/zoom)),y:Math.max(15,Math.min(665,d.startY+(e.clientY-d.y)/zoom))}:v)}));}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={e=>{const delta={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(!delta)return;e.preventDefault();setFlow(f=>({...f,nodes:f.nodes.map(v=>v.id===n.id?{...v,x:Math.max(140,Math.min(770,v.x+delta[0])),y:Math.max(15,Math.min(665,v.y+delta[1]))}:v)}));}}>
            <ChatMascot state={preview===n.id?n.kind==="tools"?"working":n.kind==="context"?"compressing":"thinking":n.kind==="answer"?"success":"idle"}/><span><strong>{n.label}</strong><small>{n.kind==="tools"?`${toolConnected?n.config.tools.length:0} 项工具 · ${n.config.maxSteps} 次探索`:n.kind==="context"?`用到 ${Math.round(n.config.threshold*100)}% 时压缩`:n.kind==="model"?"根据问题选择下一步":n.kind==="answer"?"保留一次独立收尾":"接收问题与附件"}</small></span>
          </button>
        </div>)}
        {preview&&<span className="agent-flow-demo-label">演示中 · 不调用模型</span>}
      </div></div></div></div>
      <aside className="oo-panel agent-flow-inspector"><strong>{kinds[node.kind]}节点</strong><label>节点名称<Input value={node.label} maxLength={40} onChange={e=>patch({label:e.target.value})}/></label>
        {node.kind==="tools"&&<><label>连接工具分支<Switch checked={toolConnected} onChange={on=>setFlow(f=>({...f,edges:on?[...f.edges,{from:"model",to:"tools"},{from:"tools",to:"model"}]:f.edges.filter(e=>e.from!=="tools"&&e.to!=="tools")}))}/></label><label>可用能力<Checkbox.Group options={Object.entries(toolNames).map(([value,label])=>({value,label}))} value={node.config.tools} onChange={tools=>config({tools})}/></label><label>探索次数上限<InputNumber min={1} max={32} precision={0} value={node.config.maxSteps} onChange={maxSteps=>config({maxSteps})}/></label></>}
        {node.kind==="context"&&<><label>压缩阈值<InputNumber min={30} max={85} addonAfter="%" value={Math.round(node.config.threshold*100)} onChange={v=>config({threshold:v/100})}/></label><label>最近消息保留条数<InputNumber min={2} max={16} precision={0} value={node.config.keepRecent} onChange={keepRecent=>config({keepRecent})}/></label><p>摘要保留目标、约束、已核实结果和未完成事项，历史原文仍可查看。</p></>}
        {node.kind==="model"&&<label>平台工作约定<Input.TextArea maxLength={4000} rows={7} value={flow.instructions} onChange={e=>setFlow(f=>({...f,instructions:e.target.value}))}/></label>}
        <p>拖动节点或使用方向键调整位置。账号权限与执行确认始终生效。</p>
      </aside>
    </div>
    <div className="oo-panel" style={{marginTop:20,padding:16}}><div className="oo-toolbar oo-toolbar--plain"><strong>我的实际执行轨迹</strong><Select allowClear placeholder="选择一个已有会话" style={{minWidth:220,maxWidth:"100%"}} value={sessionId||undefined} onChange={v=>setSessionId(v||"")} options={sessions.map(s=>({value:s.id,label:s.title}))}/></div>
      {traceLoading?"正在读取…":messages.filter(m=>m.role==="assistant").slice(-3).map(m=><AgentTrajectory key={m.id} parts={m.parts} finalTextId={m.parts?.findLast(p=>p.type==="text")?.id}/>)}
      {!traceLoading&&!messages.length&&<p style={{color:"var(--ink-3)"}}>选择会话，查看已完成的思考、工具与压缩记录。</p>}
    </div>
  </div>;
}
