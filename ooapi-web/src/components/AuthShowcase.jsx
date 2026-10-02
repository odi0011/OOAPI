import React, { useState } from 'react';
import { ApiOutlined, ArrowUpOutlined, CheckOutlined, CodeOutlined, FileTextOutlined, KeyOutlined, MessageOutlined, PlusOutlined, LockOutlined } from '@ant-design/icons';
import BrandLogo, { BrandName } from './BrandLogo';
import { StudioCat } from './StudioUI';
import './auth-showcase.css';

const VIEWS = [
  { key: 'chat', title: '对话', icon: <MessageOutlined/> },
  { key: 'keys', title: '令牌', icon: <KeyOutlined/> },
  { key: 'logs', title: '记录', icon: <FileTextOutlined/> },
];
export default function AuthShowcase({ isRegister, privateFocus, motion }) {
  const [view, setView] = useState('chat');
  return <section className="auth-showcase" aria-label="平台功能预览">
    <div className="auth-showcase-heading"><span className="studio-eyebrow">MODEL GATEWAY</span><h1>{isRegister ? '创建你的账户' : '模型服务控制台'}</h1><p>管理 API 令牌、查看用量，<br/>或直接开始一段对话。</p></div>
    <div className="auth-showcase-stage">
      <div className="auth-stage-orbit orbit-one"/><div className="auth-stage-orbit orbit-two"/>
      <div className="auth-workspace">
        <div className="auth-workspace-header"><span className="auth-showcase-brand"><BrandLogo size={22}/><BrandName/></span><span className="auth-preview-label">界面示意</span><i/><i/></div>
        <div className="auth-workspace-body"><nav aria-label="功能预览">{VIEWS.map(v => <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setView(v.key)}>{v.icon}<span>{v.title}</span></button>)}</nav>
          <div className="auth-workspace-content" key={view}>
            {view === 'chat' ? <><div className="auth-preview-title"><span>新对话</span><PlusOutlined/></div><div className="auth-message user">帮我检查这段接口代码。</div><div className="auth-message assistant"><BrandLogo size={21}/><p>可以。贴上代码和报错信息。<span className="auth-text-cursor"/></p></div><div className="auth-context-chip"><CodeOutlined/> 支持代码与附件</div><div className="auth-composer"><span>输入消息</span><i><ArrowUpOutlined/></i></div></>
            : view === 'keys' ? <><div className="auth-preview-title"><span>应用令牌</span><KeyOutlined/></div><div className="auth-token-preview"><span>我的应用 <CheckOutlined/></span><code>•••• •••• •••• ••••</code><div><span>模型范围</span><b>按应用配置</b></div><div><span>额度上限</span><b>单独设置</b></div></div><div className="auth-preview-caption">每个应用使用独立令牌</div></>
            : <><div className="auth-preview-title"><span>调用记录</span><FileTextOutlined/></div><div className="auth-log-header"><span>记录字段</span><span>详情</span></div>{[['请求状态','成功 / 失败'],['Token 用量','输入 / 输出 / 缓存'],['响应时间','首字 / 总耗时'],['实际扣费','OD币']].map(([k,v],i) => <div className="auth-log-row" key={k} style={{ '--row': i }}><span><i/>{k}</span><b>{v}</b></div>)}<div className="auth-preview-caption">支持按时间和模型筛选</div></>}
          </div>
        </div>
        <div className="auth-workspace-status"><span><i/> <BrandName/> workspace</span><span>API / CHAT / USAGE</span></div>
      </div>
      <div className="auth-protocol-note"><ApiOutlined/><span><b>兼容现有 SDK</b><small>Chat Completions · Messages · Responses</small></span></div>
      <div className={`auth-mascot${privateFocus ? ' is-private' : ''}`}><StudioCat pose={privateFocus ? 'doze' : isRegister ? 'wave' : 'read'} eager motion={motion.active}/><span>{privateFocus ? <><LockOutlined/> 输入密码中</> : isRegister ? '你好呀。' : '等你登录。'}</span></div>
    </div>
    <div className="auth-showcase-bottom"><span><CheckOutlined/> 三种兼容协议</span><span><CheckOutlined/> 独立应用令牌</span><span><CheckOutlined/> 调用明细</span></div>
  </section>;
}
