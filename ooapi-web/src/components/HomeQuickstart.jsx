import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { App as AntApp, Button, Segmented } from 'antd';
import { ArrowRightOutlined, CheckOutlined, CodeOutlined, CopyOutlined, KeyOutlined, LinkOutlined } from '@ant-design/icons';
import BrandLogo, { BrandName } from './BrandLogo';
import { copyText } from '../services/format';
import './home-quickstart.css';

const STEPS = [
  { title: '创建令牌', label: '准备凭据', icon: <KeyOutlined/>, text: '在令牌管理中创建一个应用令牌，然后把它保存为环境变量。', action: '打开令牌管理', to: '/token' },
  { title: '配置地址', label: '连接网关', icon: <LinkOutlined/>, text: '将客户端的 Base URL 设置为本站地址。已有应用可以继续使用原来的 SDK。', action: '查看模型定价', to: '/pricing' },
  { title: '验证连接', label: '获取模型', icon: <CodeOutlined/>, text: '运行这段代码，获取当前令牌可用的模型。后续请求请使用返回的模型 ID。', action: '查看调用记录', to: '/log' },
];
function example(step, language, endpoint) {
  if (step === 0) return language === 'cURL'
    ? '# macOS / Linux\n# 将刚创建的令牌填入环境变量\nexport OOAPI_API_KEY="替换为你的令牌"\n\n# PowerShell\n$env:OOAPI_API_KEY="替换为你的令牌"'
    : language === 'Python'
      ? '# 安装 SDK\npython -m pip install openai\n\n# 运行前设置 OOAPI_API_KEY 环境变量\n# 令牌在「令牌管理」中创建'
      : '// 安装 SDK\n// npm install openai\n\n// 运行前设置 OOAPI_API_KEY 环境变量\n// 令牌在「令牌管理」中创建';
  if (language === 'cURL') return step === 1
    ? `# Base URL\nexport OOAPI_BASE_URL="${endpoint}"\n\n# PowerShell\n$env:OOAPI_BASE_URL="${endpoint}"`
    : `# 查询当前令牌可用的模型\ncurl "${endpoint}/models" \\\n  -H "Authorization: Bearer $OOAPI_API_KEY"`;
  if (language === 'Python') return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${endpoint}",\n    api_key=os.environ["OOAPI_API_KEY"]\n)${step === 2 ? '\n\nfor model in client.models.list().data:\n    print(model.id)' : ''}`;
  return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${endpoint}",\n  apiKey: process.env.OOAPI_API_KEY\n});${step === 2 ? '\n\nconst models = await client.models.list();\nfor (const model of models.data) {\n  console.log(model.id);\n}' : ''}`;
}
function CodeLine({ text }) {
  const tokens = text.split(/("[^"\n]*"|'[^'\n]*'|#[^\n]*|\/\/[^\n]*|\b(?:import|from|const|new|await|for|in|of|export|print|curl)\b)/g);
  return tokens.map((token, i) => <span key={i} className={/^(#|\/\/)/.test(token) ? 'qs-comment' : /^["']/.test(token) ? 'qs-string' : /^(import|from|const|new|await|for|in|of|export|print|curl)$/.test(token) ? 'qs-keyword' : undefined}>{token}</span>);
}
export default function HomeQuickstart({ endpoint, docs }) {
  const [step, setStep] = useState(2);
  const [language, setLanguage] = useState('Python');
  const { message } = AntApp.useApp();
  const command = example(step, language, endpoint);
  const current = STEPS[step];
  const copy = async (text) => { try { await copyText(text); message.success({ key: 'quickstart-copy', content: '已复制' }); } catch { message.error({ key: 'quickstart-copy', content: '复制失败，请手动选择代码' }); } };
  return <section className="studio-section quickstart" id="quickstart" data-reveal>
    <div className="quickstart-heading"><div><span className="studio-eyebrow">DEVELOPER QUICKSTART</span><h2>接入 API</h2><p>准备好令牌后，先获取可用模型。</p></div>{docs && <a className="studio-text-link" href={docs} target="_blank" rel="noreferrer">完整文档 <ArrowRightOutlined/></a>}</div>
    <div className="quickstart-workbench">
      <div className="quickstart-steps" role="tablist" aria-label="接入步骤">{STEPS.map((s, i) => <button key={s.title} id={`qs-tab-${i}`} type="button" role="tab" tabIndex={step === i ? 0 : -1} aria-selected={step === i} aria-controls="quickstart-panel" onClick={() => setStep(i)} onKeyDown={e => {
        const next = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : -1;
        if (next >= 0) { e.preventDefault(); setStep(next); document.getElementById(`qs-tab-${next}`)?.focus(); }
      }}><span className="qs-step-number">0{i + 1}</span><span><b>{s.title}</b><small>{s.label}</small></span><ArrowRightOutlined/></button>)}</div>
      <div className="quickstart-body" id="quickstart-panel" role="tabpanel" aria-labelledby={`qs-tab-${step}`}>
        <div className="quickstart-editor">
          <div className="qs-editor-toolbar"><span><i/><i/><i/></span><Segmented aria-label="示例语言" size="small" value={language} onChange={setLanguage} options={['cURL', 'Python', 'Node.js']}/><Button type="text" aria-label="复制示例" icon={<CopyOutlined/>} onClick={() => copy(command)}/></div>
          <div className="qs-file-tab"><CodeOutlined/>{language === 'Python' ? 'connect.py' : language === 'Node.js' ? 'connect.mjs' : 'terminal.sh'}<span>可复制示例</span></div>
          <pre className="qs-code" key={`${step}-${language}`}><code>{command.split('\n').map((line, i) => <span className="qs-code-line" key={i}><span className="qs-line-number" aria-hidden="true">{i + 1}</span><span><CodeLine text={line || ' '}/></span>{'\n'}</span>)}</code></pre>
          <div className="qs-editor-status"><span><span className="studio-status-dot"/> HTTP / JSON</span><span>{language === 'cURL' ? '使用系统终端' : 'OpenAI SDK'}</span></div>
        </div>
        <div className="quickstart-context" key={step}>
          <div className="qs-connection" aria-hidden="true"><span>{current.icon}</span><i><b/></i><span className="qs-brand-node"><BrandLogo size={32}/></span><i><b/></i><span><CheckOutlined/></span></div>
          <span className="studio-eyebrow">STEP 0{step + 1}</span><h3>{current.title}</h3><p>{current.text}</p>
          <div className="qs-endpoint"><span><BrandName/> · BASE URL</span><div><code>{endpoint}</code><Button type="text" icon={<CopyOutlined/>} aria-label="复制 API 地址" onClick={() => copy(endpoint)}/></div></div>
          <Link className="qs-next-link" to={current.to}>{current.action}<ArrowRightOutlined/></Link>
          <div className="qs-note"><KeyOutlined/><span>示例从环境变量读取令牌。请勿把真实令牌放进前端代码。</span></div>
        </div>
      </div>
    </div>
    <div className="quickstart-foot"><span>支持 Chat Completions、Messages 与 Responses</span><a href="#products">协议介绍 <ArrowRightOutlined/></a></div>
  </section>;
}
