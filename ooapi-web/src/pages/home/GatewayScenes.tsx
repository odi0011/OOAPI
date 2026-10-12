import { useMemo, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { ArrowUpRight, Boxes, Check, Code2, FileText, Network, RefreshCw, Search, ShieldCheck, Workflow, Zap } from 'lucide-react'
import styles from './GatewayScenes.module.css'

export interface ChannelRoutingProps { className?: string }
export interface VectorRetrievalProps { className?: string; defaultQuery?: string }

const routePaths = {
  ingress: 'M117 132H204',
  primary: 'M296 126C337 126 337 76 375 76',
  fallback: 'M296 136C336 136 339 176 375 176',
}

function GridFloor() {
  return <g className={styles.floor} aria-hidden="true">
    <path d="M30 130 257 34 490 140 263 236Z" className={styles.floorFill} />
    {Array.from({ length: 11 }, (_, i) => <g key={i}>
      <path d={`M${30 + 22.7 * i} ${130 - 9.6 * i}L${263 + 22.7 * i} ${236 - 9.6 * i}`} />
      <path d={`M${30 + 23.3 * i} ${130 + 10.6 * i}L${257 + 23.3 * i} ${34 + 10.6 * i}`} />
    </g>)}
  </g>
}

function Packet({ lane, delayed = false }: { lane: keyof typeof routePaths; delayed?: boolean }) {
  const coordinates = lane === 'ingress'
    ? { cx: [119, 136, 161, 187, 204], cy: [132, 132, 132, 132, 132] }
    : lane === 'primary'
      ? { cx: [296, 320, 335, 349, 375], cy: [126, 119, 101, 83, 76] }
      : { cx: [296, 320, 338, 352, 375], cy: [136, 142, 159, 170, 176] }
  return <motion.circle r="3.1" className={styles.packet} initial={{ cx: coordinates.cx[0], cy: coordinates.cy[0], opacity: 0 }}
    animate={{ ...coordinates, opacity: [0, 1, 1, 1, 0] }}
    transition={{ duration: 2.7, repeat: Infinity, ease: 'linear', delay: delayed ? 1.35 : 0, times: [0, .2, .5, .8, 1] }} />
}

export function ChannelRouting({ className = '' }: ChannelRoutingProps) {
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLElement>(null)
  const visible = useInView(root, { margin: '60px' })
  const reduced = useReducedMotion()
  const animate = visible && !reduced

  return <article ref={root} className={`${styles.card} ${styles.routingCard} ${className}`} aria-label="账号路由策略">
    <header className={styles.heading}>
      <h3><Network size={16} />账号路由</h3>
      <button type="button" className={styles.action} onClick={() => setFailed(value => !value)} aria-pressed={failed}>
        {failed ? <RefreshCw size={13} /> : <Zap size={13} />}{failed ? '恢复账号' : '模拟故障'}
      </button>
    </header>
    <div className={styles.routingVisual}>
      <svg viewBox="0 0 520 244" role="img" aria-label={failed ? '主账号暂停，所有请求转至备用账号' : '应用请求通过 OOAPI 按 70% 与 30% 分流'}>
        <GridFloor />
        <g className={styles.routeLines}>
          <path d={routePaths.ingress} />
          <path d={routePaths.primary} className={failed ? styles.failedRoute : ''} />
          <path d={routePaths.fallback} className={failed ? styles.activeRoute : ''} />
        </g>
        {animate && <g><Packet lane="ingress" /><Packet lane="ingress" delayed />{!failed && <Packet lane="primary" />}<Packet lane="fallback" delayed={!failed} />{failed && <Packet lane="fallback" delayed />}</g>}
        <g className={styles.node} transform="translate(44 107)">
          <path d="M0 18 36 1 72 18 36 36Z" className={styles.nodeTop} />
          <path d="M0 18V31L36 49 72 31V18L36 36Z" className={styles.nodeSide} />
          <Code2 x="25" y="9" size={22} className={styles.nodeIcon} />
          <text x="36" y="72" textAnchor="middle" className={styles.nodeLabel}>应用请求</text>
        </g>
        <g className={`${styles.node} ${styles.gatewayNode}`} transform="translate(202 96)">
          <path d="M0 25 48 1 96 25 48 49Z" className={styles.nodeTop} />
          <path d="M0 25V43L48 67 96 43V25L48 49Z" className={styles.nodeSide} />
          <text x="48" y="31" textAnchor="middle" className={styles.gatewayWord}>OOAPI</text>
          <text x="48" y="90" textAnchor="middle" className={styles.nodeLabel}>优先级 · 权重</text>
        </g>
        <g className={`${styles.channelNode} ${failed ? styles.channelFailed : ''}`} transform="translate(375 50)">
          <rect width="99" height="54" rx="12" className={styles.channelSurface} />
          <circle cx="15" cy="18" r="3" className={styles.channelDot} />
          <text x="25" y="22" className={styles.channelTitle}>主账号 A</text>
          <text x="15" y="40" className={styles.channelMeta}>{failed ? '暂停 · 0%' : '128 ms · 70%'}</text>
          {failed && <path d="m78 14 7 7m0-7-7 7" className={styles.failureCross} />}
        </g>
        <g className={`${styles.channelNode} ${failed ? styles.channelSelected : ''}`} transform="translate(375 149)">
          <rect width="99" height="54" rx="12" className={styles.channelSurface} />
          <circle cx="15" cy="18" r="3" className={styles.channelDot} />
          <text x="25" y="22" className={styles.channelTitle}>备用账号 B</text>
          <text x="15" y="40" className={styles.channelMeta}>188 ms · {failed ? '100%' : '30%'}</text>
        </g>
      </svg>
      <div className={styles.routeCaption} aria-live="polite"><span className={failed ? styles.warningDot : styles.healthyDot} />{failed ? '备用账号接管流量' : '按权重分配请求'}<span>{failed ? '188' : '146'} <small>ms</small></span></div>
    </div>
    <dl className={styles.routingStats}>
      <div><dt>成功率</dt><dd>99.99<span>%</span></dd></div>
      <div><dt>健康检查</dt><dd><ShieldCheck size={13} />{failed ? '1 / 2' : '2 / 2'}</dd></div>
      <div><dt>流量分配</dt><dd>{failed ? '0 / 100' : '70 / 30'}<span>%</span></dd></div>
    </dl>
  </article>
}

type Stage = 'embed' | 'index' | 'retrieve'
type Cluster = 'reports' | 'code' | 'docs'
interface DocumentPoint { id: number; title: string; cluster: Cluster; x: number; y: number }
const clusterLabels: Record<Cluster, string> = { reports: '分析报告', code: '代码仓库', docs: '产品文档' }
const clusterCenters: Record<Cluster, [number, number]> = { reports: [128, 78], code: [303, 91], docs: [215, 166] }
const pointOffsets = [[-24, -12], [-8, -20], [16, -14], [-19, 13], [3, 1], [25, 11], [6, 24]]
const documentTitles: Record<Cluster, string[]> = {
  reports: ['月度调用分析', '模型使用趋势', 'Token 成本报告', '账号性能对比', '请求质量报告', '应用增长分析', '团队用量概览'],
  code: ['流式响应示例', 'OpenAI SDK 接入', 'Python 请求封装', '请求重试策略', 'Node.js 客户端', 'API 认证代码', '错误处理函数'],
  docs: ['令牌权限说明', '模型配置指南', '账号路由规则', '额度计费文档', '应用接入流程', '团队管理指南', 'API 接口规范'],
}
const documents: DocumentPoint[] = (Object.keys(clusterCenters) as Cluster[]).flatMap((cluster, clusterIndex) => {
  const [x, y] = clusterCenters[cluster]
  return pointOffsets.map(([dx, dy], index) => ({ id: clusterIndex * 7 + index, title: documentTitles[cluster][index], cluster, x: x + dx, y: y + dy }))
})
const stages: { value: Stage; label: string }[] = [{ value: 'embed', label: '嵌入' }, { value: 'index', label: '索引' }, { value: 'retrieve', label: '检索' }]
const presets = ['分析报告', '代码检索', '接入文档']

function queryEmbedding(query: string) {
  const text = query.trim().toLowerCase()
  const cluster: Cluster = /代码|编程|sdk|python|node|函数|流式|code/.test(text) ? 'code' : /文档|接入|权限|令牌|账号|额度|接口|docs/.test(text) ? 'docs' : 'reports'
  const [x, y] = clusterCenters[cluster]
  const hash = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0)
  return { cluster, x: x - 2 + hash % 17, y: y - 4 + hash % 13 }
}

export function VectorRetrieval({ className = '', defaultQuery = '分析报告' }: VectorRetrievalProps) {
  const [query, setQuery] = useState(defaultQuery)
  const [stage, setStage] = useState<Stage>('retrieve')
  const reduced = useReducedMotion()
  const embedding = useMemo(() => queryEmbedding(query), [query])
  const nearest = useMemo(() => documents.map(document => ({ ...document, distance: Math.hypot(document.x - embedding.x, document.y - embedding.y) }))
    .sort((a, b) => a.distance - b.distance).slice(0, 3), [embedding])
  const selectedIds = new Set(nearest.map(document => document.id))
  const vector = [(embedding.x / 380).toFixed(2), (embedding.y / 215).toFixed(2), ((embedding.x + embedding.y) / 595).toFixed(2)]

  return <article className={`${styles.card} ${styles.vectorCard} ${className}`} aria-label="语义检索工作区">
    <header className={styles.heading}><h3><Boxes size={16} />语义检索</h3><span className={styles.documentCount}><FileText size={12} />21 份文档</span></header>
    <div className={styles.queryRow}>
      <label className={styles.queryInput}><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} maxLength={80} placeholder="搜索你的知识库" aria-label="语义检索查询" /><ArrowUpRight size={13} /></label>
      <div className={styles.queryPresets} aria-label="常用查询">{presets.map(preset => <button key={preset} type="button" aria-pressed={query === preset} onClick={() => setQuery(preset)}>{preset}</button>)}</div>
    </div>
    <div className={styles.stageTabs} role="group" aria-label="语义检索阶段">
      {stages.map((item, index) => <button type="button" key={item.value} aria-pressed={stage === item.value} onClick={() => setStage(item.value)}><span>{index + 1}</span>{item.label}{stage === item.value && <Check size={11} />}</button>)}
    </div>
    <div className={styles.retrievalBody}>
      <svg className={styles.vectorPlot} viewBox="0 0 400 230" role="img" aria-label={`${clusterLabels[embedding.cluster]}的${stage === 'retrieve' ? '相关文档' : stage === 'index' ? '语义索引' : '向量嵌入'}`}>
        <g className={styles.vectorGrid}>{[40, 80, 120, 160, 200].map(value => <path key={'h' + value} d={`M20 ${value}H385`} />)}{[50, 100, 150, 200, 250, 300, 350].map(value => <path key={'v' + value} d={`M${value} 15V216`} />)}</g>
        {stage === 'index' && (Object.entries(clusterCenters) as [Cluster, [number, number]][]).map(([cluster, [x, y]]) => <g key={cluster} className={styles.clusterBoundary}><ellipse cx={x} cy={y + 5} rx="47" ry="40" /><text x={x} y={y + 55} textAnchor="middle">{clusterLabels[cluster]}</text></g>)}
        {stage === 'retrieve' && nearest.map(document => <motion.line key={document.id} className={styles.neighborLine} initial={false} animate={{ x1: embedding.x, y1: embedding.y, x2: document.x, y2: document.y }} transition={{ duration: reduced ? 0 : .3 }} />)}
        {documents.map(document => <motion.circle key={document.id} className={`${styles.documentPoint} ${stage === 'retrieve' && selectedIds.has(document.id) ? styles.neighborPoint : ''}`} cx={document.x} cy={document.y} r={stage === 'retrieve' && selectedIds.has(document.id) ? 5 : 3.8} initial={false} animate={{ opacity: stage === 'embed' ? .55 : stage === 'retrieve' && document.cluster !== embedding.cluster ? .35 : 1 }} transition={{ duration: reduced ? 0 : .24 }} />)}
        <motion.g className={styles.queryPoint} initial={false} animate={{ x: embedding.x, y: embedding.y }} transition={{ duration: reduced ? 0 : .38, ease: [.22, 1, .36, 1] }}>
          <circle r="11" className={styles.queryHalo} /><circle r="4.5" /><path d="M-2 0H2M0-2V2" /><text y="-18" textAnchor="middle">查询</text>
        </motion.g>
      </svg>
      <div className={styles.ranking} aria-live="polite">
        <h4>{stage === 'embed' ? '查询向量' : stage === 'index' ? '语义分组' : '相关内容'}</h4>
        {stage === 'embed'
          ? vector.map((value, index) => <div className={styles.dimensionRow} key={index}><span>维度 {index + 1}</span><b>{value}</b><span className={styles.dimensionTrack}><i style={{ width: `${Number(value) * 100}%` }} /></span></div>)
          : stage === 'index'
            ? (Object.keys(clusterCenters) as Cluster[]).map(cluster => <div className={styles.clusterRow} key={cluster} data-selected={embedding.cluster === cluster || undefined}><Workflow size={13} /><span>{clusterLabels[cluster]}</span><b>7</b></div>)
            : nearest.map((document, index) => <motion.div className={styles.rankRow} key={document.id} initial={false} animate={{ opacity: 1 }}><span className={styles.rankNumber}>{index + 1}</span><div><strong>{document.title}</strong><small>{clusterLabels[document.cluster]}</small></div><b>{(100 - document.distance / 4).toFixed(1)}<small>%</small></b></motion.div>)}
      </div>
    </div>
    <div className={styles.vectorFooter}><span>{stage === 'embed' ? '将查询映射到语义空间' : stage === 'index' ? '按语义关联组织内容' : '找到最相关的内容'}</span><span>{stage === 'retrieve' ? 'Top 3' : stage === 'index' ? '3 个分组' : '768 维'}</span></div>
  </article>
}
