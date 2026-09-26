// 消息中心右侧聊天区：顶栏 / 消息流 / 输入框
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Image, Input, Popover, Spin, Tooltip } from "antd";
import {
  ArrowLeftOutlined, SendOutlined, SmileOutlined, PictureOutlined, CodeOutlined, MoreOutlined,
  CopyOutlined, UndoOutlined, DownOutlined, InfoCircleOutlined, ReloadOutlined, DeleteOutlined,
} from "@ant-design/icons";
import UserAvatar from "../UserAvatar";
import Markdown from "../Markdown";
import { buildRows, fmtClock, nameOf, RoomAvatar, RECALL_WINDOW_SEC, MAX_TEXT } from "./im-utils";

const EMOJI = ["😀", "😄", "😁", "😂", "🤣", "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😎", "🥳", "🤔", "🤫", "🤗", "😅", "😭", "😴", "🙏", "👍", "👏", "💪", "🎉", "🔥", "✨", "💡", "🚀", "❤️", "⭐", "💯"];

export function ChatHeader({ room, subtitle, online, onBack, infoOpen, onToggleInfo, menuItems }) {
  return (
    <header className="oo-im-chat-head">
      <Button type="text" className="oo-im-mobile-only" icon={<ArrowLeftOutlined />} aria-label="返回会话列表" onClick={onBack} />
      <button type="button" className="oo-im-chat-id" onClick={onToggleInfo} aria-label="查看会话资料">
        <RoomAvatar room={room} size={34} online={online} />
        <span style={{ minWidth: 0 }}>
          <span className="oo-im-chat-title oo-truncate">{room?.title || room?.name || "会话"}</span>
          <span className={`oo-im-chat-sub${online ? " is-on" : ""}`}>{subtitle}</span>
        </span>
      </button>
      <div className="oo-im-chat-actions">
        <Tooltip title={infoOpen ? "收起资料栏" : room?.type === "single" ? "对方资料" : "群资料与成员"}>
          <Button type="text" icon={<InfoCircleOutlined />} aria-pressed={infoOpen} aria-label="资料栏" onClick={onToggleInfo} className={infoOpen ? "is-on" : ""} />
        </Tooltip>
        {menuItems?.length ? (
          <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
            <Button type="text" icon={<MoreOutlined />} aria-label="更多操作" />
          </Dropdown>
        ) : null}
      </div>
    </header>
  );
}

// 超长消息（粘贴的日志 / JSON）默认折叠，不让一条消息刷掉整屏上下文
const LONG_CHARS = 600;
const LONG_LINES = 14;

function Bubble({ m, mine, onRecall, onCopy, onRetry, onDiscard }) {
  const [expanded, setExpanded] = useState(false);
  const recalled = Number(m.status) === 2;
  const canRecall = mine && m.id > 0 && !m.pending && !m.failed && !recalled && Date.now() / 1000 - Number(m.created_time) < RECALL_WINDOW_SEC;
  const media = m.media || [];
  const text = m.content || "";
  const long = text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
  const collapsed = long && !expanded;
  return (
    <>
      <div className="oo-im-msg-line">
        <div className={`oo-im-bubble${mine ? " is-mine" : ""}${m.pending ? " is-pending" : ""}${m.failed ? " is-failed" : ""}${recalled ? " is-recalled" : ""}${!text && media.length ? " is-media" : ""}`}>
          {recalled ? (
            <span>{mine ? "你撤回了一条消息" : "对方撤回了一条消息"}</span>
          ) : (
            <>
              {text ? (
                <div className={collapsed ? "oo-im-clamp oo-msg-collapsed" : undefined}>
                  <Markdown text={text} />
                </div>
              ) : null}
              {long ? (
                <button type="button" className="oo-im-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                  {expanded ? "收起" : `展开全文（${text.length} 字）`}
                </button>
              ) : null}
              {media.length ? (
                <div className={`oo-im-media${media.length > 1 ? " is-multi" : ""}`}>
                  <Image.PreviewGroup>
                    {media.map((img) => (
                      <Image key={img.id} src={img.url} alt="图片" preview={!m.pending} />
                    ))}
                  </Image.PreviewGroup>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="oo-im-msg-tools">
          <span className="oo-im-msg-time">{m.pending ? "发送中" : fmtClock(m.created_time)}</span>
          {!recalled && m.content ? (
            <Tooltip title="复制"><button type="button" className="oo-im-icon-btn" aria-label="复制" onClick={() => onCopy(m)}><CopyOutlined /></button></Tooltip>
          ) : null}
          {canRecall ? (
            <Tooltip title="撤回（2 分钟内）"><button type="button" className="oo-im-icon-btn" aria-label="撤回" onClick={() => onRecall(m)}><UndoOutlined /></button></Tooltip>
          ) : null}
        </div>
      </div>
      {m.failed ? (
        <div className="oo-im-msg-fail" role="alert">
          发送失败{m.error ? `：${m.error}` : ""}
          <button type="button" onClick={() => onRetry(m)}><ReloadOutlined /> 重试</button>
          <button type="button" onClick={() => onDiscard(m)}><DeleteOutlined /> 删除</button>
        </div>
      ) : null}
    </>
  );
}
/**
 * 消息流。滚动规则：
 *   · 贴底（距底 < 80px）时新消息自动滚到底；不贴底时不打断阅读，改为显示「N 条新消息」；
 *   · 自己发的消息永远滚到底；
 *   · 加载更早的消息后保持当前视口位置不跳（按插入前后的高度差补偿）；
 *   · 图片/代码块异步撑高内容时，贴底状态下继续贴底（ResizeObserver）。
 */
export function MessageList({ roomId, roomType, msgs, loading, hasMore, loadingMore, me, onLoadMore, onUserClick, onRecall, onCopy, onRetry, onDiscard, onDropFile }) {
  const scrollRef = useRef(null);
  const innerRef = useRef(null);
  const stick = useRef(true);
  const snap = useRef({ first: "", last: "", height: 0 });
  const [unseen, setUnseen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rows = useMemo(() => buildRows(msgs), [msgs]);

  useEffect(() => {
    stick.current = true;
    setUnseen(0);
  }, [roomId]);

  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    stick.current = true;
    setUnseen(0);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = msgs[0] ? String(msgs[0].client_id || msgs[0].id) : "";
    const lastMsg = msgs[msgs.length - 1];
    const last = lastMsg ? String(lastMsg.client_id || lastMsg.id) : "";
    const prev = snap.current;
    if (prev.last && prev.last === last && prev.first && prev.first !== first) {
      // 顶部插入了更早的消息：按高度差补偿，视口停在原来那条上
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (last !== prev.last) {
      if (stick.current || (lastMsg && lastMsg.user_id === me?.id) || !prev.last) toBottom();
      else setUnseen((n) => n + 1);
    }
    snap.current = { first, last, height: el.scrollHeight };
  }, [msgs, me?.id]);

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
      if (scrollRef.current) snap.current.height = scrollRef.current.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [roomId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = nearBottom;
    if (nearBottom && unseen) setUnseen(0);
    if (el.scrollTop < 60 && hasMore && !loadingMore) {
      snap.current.height = el.scrollHeight;
      onLoadMore();
    }
  };

  const dropProps = {
    onDragOver: (e) => {
      if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
    },
    onDrop: (e) => {
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
      setDragging(false);
      if (file) {
        e.preventDefault();
        onDropFile(file);
      }
    },
  };

  return (
    <div className="oo-im-stream-wrap" {...dropProps}>
      <div className="oo-im-stream" ref={scrollRef} onScroll={onScroll} aria-live="polite">
        <div className="oo-im-stream-inner" ref={innerRef}>
          {loading ? (
            <div className="oo-im-stream-loading"><Spin /></div>
          ) : (
            <>
              <div className="oo-im-stream-top">
                {hasMore ? (
                  <button type="button" className="oo-im-link-btn" onClick={() => { snap.current.height = scrollRef.current?.scrollHeight || 0; onLoadMore(); }} disabled={loadingMore}>
                    {loadingMore ? "加载中…" : "查看更早的消息"}
                  </button>
                ) : msgs.length ? (
                  <span>没有更早的消息了</span>
                ) : null}
              </div>
              {!msgs.length ? <div className="oo-im-stream-empty">还没有消息，说点什么打个招呼吧</div> : null}
              {rows.map((row) => {
                if (row.kind === "day") return <div key={row.key} className="oo-im-day"><span>{row.label}</span></div>;
                if (row.kind === "system") return <div key={row.key} className="oo-im-system"><span>{row.msg.content}</span></div>;
                const m = row.msg;
                const mine = m.user_id === me?.id;
                const showHead = !row.continued;
                return (
                  <div key={row.key} className={`oo-im-msg${mine ? " is-mine" : ""}${row.continued ? " is-continued" : ""}${row.last ? " is-last" : ""}`}>
                    {!mine ? (
                      <div className="oo-im-msg-avatar">
                        {showHead ? (
                          <button type="button" className="oo-im-avatar-btn" onClick={() => onUserClick(m.author || { id: m.user_id })} aria-label={`查看 ${nameOf(m.author)} 的资料`}>
                            <UserAvatar user={m.author} size={34} />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="oo-im-msg-body">
                      {showHead && !mine && roomType !== "single" ? <div className="oo-im-msg-name">{nameOf(m.author)}</div> : null}
                      <Bubble m={m} mine={mine} onRecall={onRecall} onCopy={onCopy} onRetry={onRetry} onDiscard={onDiscard} />
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      {unseen ? (
        <button type="button" className="oo-im-jump" onClick={() => toBottom(true)}>
          <DownOutlined /> {unseen} 条新消息
        </button>
      ) : null}
      {dragging ? <div className="oo-im-drop">松开发送图片</div> : null}
    </div>
  );
}
/**
 * 输入框。Enter 发送 / Shift+Enter 换行；**输入法组字中按 Enter 不发送**
 * （原实现不判 isComposing：拼音选词按回车会把半截拼音直接发出去）。
 * 外层保留 .oo-msg-input 类名：tests/e2e-browser.mjs 用它定位输入框。
 */
export function Composer({ roomId, value, onChange, onSend, onFile, sending, disabled, placeholder }) {
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const el = () => taRef.current?.resizableTextArea?.textArea || null;

  useEffect(() => {
    // 切换会话后把焦点放回输入框（桌面端）；触屏设备不抢焦点，否则会弹键盘挡住消息
    if (window.matchMedia?.("(pointer: fine)").matches) el()?.focus();
  }, [roomId]);

  const insert = (text) => {
    const ta = el();
    if (!ta) return onChange(value + text);
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const len = value.length;
  const tooLong = len > MAX_TEXT;

  return (
    <div className="oo-msg-input oo-im-composer">
      <div className={`oo-im-composer-box${disabled ? " is-disabled" : ""}`}>
        <Input.TextArea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoSize={{ minRows: 1, maxRows: 8 }}
          disabled={disabled}
          variant="borderless"
          onPaste={(e) => {
            const img = [...(e.clipboardData?.items || [])].find((it) => it.kind === "file" && it.type.startsWith("image/"));
            const f = img?.getAsFile();
            if (f) {
              e.preventDefault();
              onFile(f);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              if (!tooLong) onSend();
            }
          }}
          aria-label="输入消息"
        />
        <div className="oo-im-composer-bar">
          <div className="oo-im-composer-tools">
            <Popover
              open={emojiOpen}
              onOpenChange={setEmojiOpen}
              trigger="click"
              placement="topLeft"
              content={
                <div className="oo-im-emoji-grid">
                  {EMOJI.map((e) => (
                    <button key={e} type="button" onClick={() => { insert(e); setEmojiOpen(false); }} aria-label={e}>{e}</button>
                  ))}
                </div>
              }
            >
              <Tooltip title="表情"><button type="button" className="oo-im-icon-btn" aria-label="表情" disabled={disabled}><SmileOutlined /></button></Tooltip>
            </Popover>
            <Tooltip title="图片（也可以直接粘贴或拖进来）">
              <button type="button" className="oo-im-icon-btn" aria-label="发送图片" disabled={disabled} onClick={() => fileRef.current?.click()}>
                <PictureOutlined />
              </button>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) onFile(f);
              }}
            />
            <Tooltip title="代码块">
              <button type="button" className="oo-im-icon-btn" aria-label="插入代码块" disabled={disabled} onClick={() => insert("\n```\n\n```\n")}>
                <CodeOutlined />
              </button>
            </Tooltip>
          </div>
          <div className="oo-im-composer-send">
            {len > MAX_TEXT - 500 ? <span className={`oo-im-count${tooLong ? " is-over" : ""}`}>{len}/{MAX_TEXT}</span> : <span className="oo-im-hint">Enter 发送 · Shift+Enter 换行</span>}
            <Button type="primary" size="small" icon={<SendOutlined />} loading={sending} disabled={disabled || tooLong || !value.trim()} onClick={onSend}>
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
