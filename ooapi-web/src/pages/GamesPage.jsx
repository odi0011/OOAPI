// Playground（小游戏）—— 单机成绩榜 + 联机对战
// ---------------------------------------------------------------------------
// 视觉定位（Gemini 第 6 点）：**Terminal Arcade**，不引卡通/糖果色/3D 质感。
//   · 颜色只用设计系统变量：棋盘 --surface/--line（1px 细线），
//     棋子/方块只用 --accent 与 --ink（单色扁平）；
//   · 排行榜复用 RankBar，与「模型用量排行」100% 一致；
//   · 联机对战叫「P2P 对局」，模块整体叫 Playground，文案去娱乐化。
//
// **键盘只在组件获焦时接管**（失焦立刻释放）：绝不劫持浏览器的翻页/滚动。
//
// 联机对战（五子棋）是**服务端权威**：客户端只发落子坐标，胜负由后端判定；
// 前端渲染服务端返回的棋盘，不自己算输赢（否则改前端就能作弊）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Space, Tag, Empty, App as AntApp, Segmented, List, Tooltip, Skeleton, Modal, InputNumber,
} from "antd";
import {
  ReloadOutlined, TrophyOutlined, ThunderboltOutlined, GlobalOutlined, PlayCircleOutlined,
  PlusOutlined, CrownOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { RankBar } from "../components/Charts";
import UserAvatar from "../components/UserAvatar";
import { fmtDate } from "../services/format";

/* ===========================================================================
   单机：2048
   =========================================================================== */
function G2048({ onScore, focusRef }) {
  const [board, setBoard] = useState(() => newBoard2048());
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);

  useEffect(() => {
    focusRef.current?.focus();
  }, [focusRef]);

  const reset = () => {
    setBoard(newBoard2048());
    setScore(0);
    setOver(false);
  };

  const move = (dir) => {
    if (over) return;
    const { board: next, gained, moved } = slide2048(board, dir);
    if (!moved) return;
    const withNew = addTile(next);
    const newScore = score + gained;
    setBoard(withNew);
    setScore(newScore);
    if (!canMove(withNew)) {
      setOver(true);
      onScore?.(newScore);
    }
  };

  const onKey = (e) => {
    const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right" };
    const dir = map[e.key] || map[e.key?.toLowerCase?.()];
    if (!dir) return;
    // 只在组件获焦时拦截按键（preventDefault 会阻止页面滚动，必须克制）
    e.preventDefault();
    move(dir);
  };

  return (
    <div className="oo-game-stage">
      <div className="oo-game-hud">
        <span>分数 <b className="oo-num">{score}</b></span>
        <span>操作：方向键 / WASD（需先点一下棋盘）</span>
        <Button size="small" onClick={reset} icon={<ReloadOutlined />}>重开</Button>
      </div>
      <div
        className="oo-game-canvas"
        tabIndex={0}
        role="application"
        aria-label="2048 棋盘"
        onKeyDown={onKey}
        onClick={(e) => e.currentTarget.focus()}
        style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, padding: 8, width: "100%", height: "100%" }}>
          {board.map((v, i) => (
            <div
              key={i}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "var(--r-sm)",
                background: v ? `color-mix(in srgb, var(--accent) ${Math.min(90, 18 + Math.log2(v) * 11)}%, var(--inset))` : "var(--inset)",
                border: "1px solid var(--line)",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                fontSize: v >= 1024 ? 15 : v >= 128 ? 18 : 21,
                color: v ? "var(--ink)" : "transparent",
              }}
            >
              {v || ""}
            </div>
          ))}
        </div>
        {over ? (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 10,
              background: "color-mix(in srgb, var(--surface) 88%, transparent)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>本局结束 · {score} 分</div>
            <Space>
              <Button type="primary" onClick={reset}>再来一局</Button>
            </Space>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function newBoard2048() {
  const b = new Array(16).fill(0);
  return addTile(addTile(b));
}
function addTile(b) {
  const empty = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!empty.length) return b;
  const idx = empty[Math.floor(Math.random() * empty.length)];
  const next = b.slice();
  next[idx] = Math.random() < 0.9 ? 2 : 4;
  return next;
}
/** 单行左滑：合并同值（每格每轮只合并一次） */
function slideLine(line) {
  const items = line.filter((v) => v);
  const out = [];
  let gained = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] === items[i + 1]) {
      const merged = items[i] * 2;
      out.push(merged);
      gained += merged;
      i += 1;
    } else out.push(items[i]);
  }
  while (out.length < 4) out.push(0);
  return { out, gained };
}
function slide2048(board, dir) {
  const size = 4;
  const idx = (r, c) => r * size + c;
  let next = new Array(16).fill(0);
  let gained = 0;
  let moved = false;
  for (let i = 0; i < size; i += 1) {
    // 按方向取出一整行/列（left/up 正向，right/down 反向）
    const line = [];
    for (let j = 0; j < size; j += 1) {
      if (dir === "left") line.push(board[idx(i, j)]);
      else if (dir === "right") line.push(board[idx(i, size - 1 - j)]);
      else if (dir === "up") line.push(board[idx(j, i)]);
      else line.push(board[idx(size - 1 - j, i)]);
    }
    const { out, gained: g } = slideLine(line);
    gained += g;
    for (let j = 0; j < size; j += 1) {
      if (dir === "left") next[idx(i, j)] = out[j];
      else if (dir === "right") next[idx(i, size - 1 - j)] = out[j];
      else if (dir === "up") next[idx(j, i)] = out[j];
      else next[idx(size - 1 - j, i)] = out[j];
    }
  }
  for (let i = 0; i < 16; i += 1) if (next[i] !== board[i]) moved = true;
  return { board: next, gained, moved };
}
function canMove(b) {
  if (b.includes(0)) return true;
  for (const dir of ["up", "down", "left", "right"]) {
    if (slide2048(b, dir).moved) return true;
  }
  return false;
}

/* ===========================================================================
   单机：贪吃蛇
   =========================================================================== */
function SnakeGame({ onScore, focusRef }) {
  const SIZE = 16;
  const [snake, setSnake] = useState([{ x: 8, y: 8 }]);
  const [food, setFood] = useState({ x: 4, y: 4 });
  const [dir, setDir] = useState({ x: 1, y: 0 });
  const [running, setRunning] = useState(false);
  const [dead, setDead] = useState(false);
  const [score, setScore] = useState(0);
  const dirRef = useRef(dir);
  dirRef.current = dir;

  const reset = () => {
    setSnake([{ x: 8, y: 8 }]);
    setFood({ x: 4, y: 4 });
    setDir({ x: 1, y: 0 });
    setScore(0);
    setDead(false);
    setRunning(false);
  };

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      setSnake((prev) => {
        const d = dirRef.current;
        const head = { x: prev[0].x + d.x, y: prev[0].y + d.y };
        if (head.x < 0 || head.y < 0 || head.x >= SIZE || head.y >= SIZE || prev.some((s) => s.x === head.x && s.y === head.y)) {
          setRunning(false);
          setDead(true);
          setScore((s) => {
            onScore?.(s);
            return s;
          });
          return prev;
        }
        const ate = head.x === food.x && head.y === food.y;
        const next = [head, ...prev];
        if (!ate) next.pop();
        else {
          setScore((s) => s + 10);
          // 食物重投到空格子（投到蛇身上会让游戏无法继续）
          const free = [];
          for (let x = 0; x < SIZE; x += 1) for (let y = 0; y < SIZE; y += 1) if (!next.some((s) => s.x === x && s.y === y)) free.push({ x, y });
          setFood(free[Math.floor(Math.random() * free.length)] || { x: 0, y: 0 });
        }
        return next;
      });
    }, 130);
    return () => clearInterval(timer);
  }, [running, food, onScore]);

  const onKey = (e) => {
    const map = {
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
      w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
    };
    const nd = map[e.key] || map[e.key?.toLowerCase?.()];
    if (!nd) return;
    e.preventDefault();
    const cur = dirRef.current;
    // 不能 180 度掉头（会立刻撞到自己）
    if (cur.x + nd.x === 0 && cur.y + nd.y === 0) return;
    setDir(nd);
    if (!running && !dead) setRunning(true);
  };

  return (
    <div className="oo-game-stage">
      <div className="oo-game-hud">
        <span>分数 <b className="oo-num">{score}</b></span>
        <span>操作：方向键 / WASD 起步（需先点一下棋盘）</span>
        <Button size="small" onClick={reset} icon={<ReloadOutlined />}>重开</Button>
      </div>
      <div
        className="oo-game-canvas"
        tabIndex={0}
        role="application"
        aria-label="贪吃蛇棋盘"
        onKeyDown={onKey}
        onClick={(e) => e.currentTarget.focus()}
        style={{ padding: 6 }}
      >
        <div
          className="oo-game-grid"
          style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)`, gridTemplateRows: `repeat(${SIZE}, 1fr)`, width: "100%", height: "100%" }}
        >
          {Array.from({ length: SIZE * SIZE }, (_, i) => {
            const x = i % SIZE;
            const y = Math.floor(i / SIZE);
            const isSnake = snake.some((s) => s.x === x && s.y === y);
            const isHead = snake[0]?.x === x && snake[0]?.y === y;
            const isFood = food.x === x && food.y === y;
            return (
              <span
                key={i}
                className={`oo-game-cell${isSnake ? " is-a" : ""}`}
                style={
                  isHead
                    ? { background: "var(--accent)" }
                    : isFood
                      ? { background: "var(--ink-3)" }
                      : undefined
                }
              />
            );
          })}
        </div>
        {dead || !running ? (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 10,
              background: "color-mix(in srgb, var(--surface) 82%, transparent)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>{dead ? `本局结束 · ${score} 分` : "按方向键开始"}</div>
            {dead ? <Button type="primary" onClick={reset}>再来一局</Button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ===========================================================================
   联机：五子棋 / 井字棋（服务端权威判定）
   =========================================================================== */
function OnlineGame({ me, toast }) {
  const { begin, isLatest } = useLatest();
  const [rooms, setRooms] = useState([]);
  const [myRooms, setMyRooms] = useState([]);
  const [gameKey, setGameKey] = useState("gomoku");
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(false);
  const esRef = useRef(null);

  const loadRooms = useCallback(async () => {
    const token = begin();
    setLoading(true);
    try {
      const [r, my] = await Promise.all([
        API.get("/games/rooms", { params: { game_key: gameKey } }),
        API.get("/games/my-rooms"),
      ]);
      if (!isLatest(token)) return;
      setRooms(Array.isArray(r) ? r : []);
      setMyRooms(Array.isArray(my) ? my : []);
    } catch (e) {
      if (isLatest(token)) toast.error(e.message);
    } finally {
      if (isLatest(token)) setLoading(false);
    }
  }, [begin, gameKey, isLatest, toast]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  // 订阅对局推送：对手落子/加入后立即刷新棋盘（不轮询）
  useEffect(() => {
    let closed = false;
    let es = null;
    (async () => {
      try {
        const { ticket } = await API.post("/chatroom/stream-ticket", {});
        if (closed) return;
        es = new EventSource(`/api/chatroom/stream?ticket=${encodeURIComponent(ticket)}`);
        esRef.current = es;
        const onMove = (ev) => {
          try {
            const d = JSON.parse(ev.data);
            // 只处理自己参与的对局：别人的对局变化与本页无关
            setRoom((prev) => (prev && Number(prev.id) === Number(d.id) ? d : prev));
            loadRooms();
          } catch {
            /* ignore */
          }
        };
        es.addEventListener("game_move", onMove);
        es.addEventListener("game_joined", onMove);
      } catch {
        /* 无实时也能玩（点刷新） */
      }
    })();
    return () => {
      closed = true;
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    };
  }, [loadRooms]);

  const openRoom = async (id) => {
    try {
      const d = await API.get(`/games/rooms/${id}`);
      setRoom(d);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const createRoom = async () => {
    try {
      const r = await API.post("/games/rooms", { game_key: gameKey });
      toast.success("房间已创建，等待对手加入");
      await loadRooms();
      openRoom(r.id);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const joinRoom = async (id) => {
    try {
      const r = await API.post(`/games/rooms/${id}/join`);
      setRoom(r);
      toast.success("已加入对局");
      await loadRooms();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const move = async (pos) => {
    if (!room || room.status !== "playing") return;
    if (!room.my_turn) {
      toast.warning("还没轮到你");
      return;
    }
    try {
      const r = await API.post(`/games/rooms/${room.id}/move`, { position: pos });
      setRoom(r);
      if (r.status === "finished") {
        toast.success(r.winner_id ? (Number(r.winner_id) === Number(me?.id) ? "你赢了" : "你输了") : "平局");
      }
    } catch (e) {
      toast.error(e.message);
    }
  };

  const resign = async () => {
    if (!room) return;
    try {
      await API.post(`/games/rooms/${room.id}/resign`);
      toast.info("已认输");
      setRoom(null);
      loadRooms();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (room) {
    const size = room.size || 15;
    const isMine = Number(room.host_id) === Number(me?.id) || Number(room.guest_id) === Number(me?.id);
    return (
      <div className="oo-game-stage">
        <div className="oo-game-hud">
          <span>
            {room.game_name} · 对局 #{room.id} ·{" "}
            {room.status === "waiting" ? "等待对手" : room.status === "playing" ? (room.my_turn ? "轮到你落子" : "等待对手落子") : room.winner_id ? (Number(room.winner_id) === Number(me?.id) ? "你赢了" : "对手获胜") : "平局"}
          </span>
          <span>
            你执 {room.my_side === 1 ? "● 先手" : room.my_side === 2 ? "○ 后手" : "观战"}
          </span>
          <Space>
            {room.status === "waiting" ? (
              <Button size="small" type="primary" onClick={() => joinRoom(room.id)} disabled={!isMine}>加入对局</Button>
            ) : null}
            <Button size="small" onClick={() => setRoom(null)}>返回列表</Button>
            {room.status === "playing" ? <Button size="small" danger onClick={resign}>认输</Button> : null}
          </Space>
        </div>
        <div
          className="oo-game-canvas"
          style={{ maxWidth: 520, aspectRatio: "1 / 1", padding: 6 }}
        >
          <div
            className="oo-game-grid"
            style={{
              gridTemplateColumns: `repeat(${size}, 1fr)`,
              gridTemplateRows: `repeat(${size}, 1fr)`,
              width: "100%",
              height: "100%",
              gap: 0,
            }}
          >
            {(room.board?.length ? room.board : new Array(size * size).fill(0)).map((v, i) => (
              <span
                key={i}
                className={`oo-game-cell${v === 1 ? " is-a" : v === 2 ? " is-b" : ""}`}
                role="button"
                tabIndex={-1}
                onClick={() => !v && move(i)}
                style={{
                  cursor: !v && room.status === "playing" && room.my_turn ? "pointer" : "default",
                  background: v ? undefined : "transparent",
                  border: "0.5px solid var(--line)",
                  borderRadius: 0,
                }}
                title={v === 1 ? "先手" : v === 2 ? "后手" : ""}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="oo-game-hud" style={{ justifyContent: "flex-start", marginBottom: 10 }}>
        <Segmented
          value={gameKey}
          onChange={setGameKey}
          options={[
            { value: "gomoku", label: "五子棋" },
            { value: "tictactoe", label: "井字棋" },
          ]}
        />
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={createRoom}>创建房间</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadRooms} loading={loading}>刷新</Button>
      </div>

      {myRooms.length ? (
        <div style={{ marginBottom: 12 }}>
          <div className="oo-chart-card-title" style={{ marginBottom: 6 }}>进行中的对局</div>
          {myRooms.map((r) => (
            <div key={r.id} className="oo-post-item" style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }} onClick={() => openRoom(r.id)}>
              <span style={{ flex: 1, fontSize: 12.5 }}>
                {r.game_name} · 对手 {r.opponent?.name || "（等待中）"}
                {r.my_turn ? <Tag color="green" style={{ marginLeft: 6 }}>轮到你</Tag> : null}
                {r.status === "waiting" ? <Tag style={{ marginLeft: 6 }}>等待加入</Tag> : null}
              </span>
              <PlayCircleOutlined style={{ color: "var(--accent)" }} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="oo-chart-card-title" style={{ marginBottom: 6 }}>
        <GlobalOutlined /> 公开对局（可加入）
      </div>
      {loading && !rooms.length ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : !rooms.length ? (
        <Empty description="当前没有等待中的房间，创建一个等对手加入" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <List
          size="small"
          dataSource={rooms}
          renderItem={(r) => (
            <List.Item
              actions={[
                r.status === "waiting" && !r.is_mine ? (
                  <Button size="small" type="primary" onClick={() => joinRoom(r.id)}>加入</Button>
                ) : (
                  <Button size="small" onClick={() => openRoom(r.id)}>{r.is_mine ? "回到对局" : "观战"}</Button>
                ),
              ]}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Tag>{r.game_name}</Tag>
                <span className="oo-truncate" style={{ fontSize: 12.5 }}>
                  {r.host_name || `用户 #${r.host_id}`}
                  {r.guest_id ? ` vs ${r.guest_name || `用户 #${r.guest_id}`}` : " vs 等待对手"}
                </span>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {r.status === "waiting" ? "等待中" : `已落 ${r.move_count} 子`}
                </span>
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

/* ===========================================================================
   页面：Playground
   =========================================================================== */
export default function GamesPage() {
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();
  const { user: me } = useApp();
  const { begin, isLatest } = useLatest();

  const [tab, setTab] = useState("g2048");
  const [board, setBoard] = useState({ items: [], total: 0, mine: { best: 0, plays: 0 } });
  const [boardLoading, setBoardLoading] = useState(false);
  const focusRef = useRef(null);

  const gameKey = tab === "snake" ? "snake" : "g2048";

  const loadBoard = useCallback(async () => {
    const token = begin();
    setBoardLoading(true);
    try {
      const d = await API.get("/games/records", { params: { game_key: gameKey, p: 1, page_size: 15 } });
      if (!isLatest(token)) return;
      setBoard({ items: d?.items || [], total: d?.total || 0, mine: d?.mine || { best: 0, plays: 0 } });
    } catch (e) {
      if (isLatest(token)) toast.error(e.message);
    } finally {
      if (isLatest(token)) setBoardLoading(false);
    }
  }, [begin, gameKey, isLatest, toast]);

  useEffect(() => {
    if (tab === "g2048" || tab === "snake") loadBoard();
  }, [tab, loadBoard]);

  // 交成绩：单机游戏的分数由前端上报（无法完全防伪），
  // 后端有上限校验与频率限制。排行榜定位是「乐子」，UI 上不宣称公平竞技。
  const submitScore = useCallback(
    async (score) => {
      if (!score) return;
      try {
        const r = await API.post("/games/records", { game_key: gameKey, score, duration_ms: 0 });
        toast.success(r?.is_record ? `新纪录！${score} 分` : `本局 ${score} 分`);
        loadBoard();
      } catch (e) {
        toast.error(e.message);
      }
    },
    [gameKey, loadBoard, toast]
  );

  return (
    <div className="oo-page">
      <PageHeader
        title="Playground"
        tags={<Tag>休息一下</Tag>}
        extra={
          <Button icon={<ReloadOutlined />} onClick={loadBoard} title="刷新榜单" aria-label="刷新榜单" />
        }
      />

      {/* 汇总用紧凑统计卡（全站统一形态） */}
      <div className="oo-stats-cards">
        <StatCard label="我的最高分" value={board.mine?.best ?? 0} hint={`${gameKey === "snake" ? "贪吃蛇" : "2048"} 个人纪录`} />
        <StatCard label="对局次数" value={board.mine?.plays ?? 0} suffix="局" hint="含未上榜的局" />
        <StatCard label="榜上人数" value={board.total ?? 0} suffix="人" hint="有成绩记录的玩家" />
      </div>

      <div className="oo-chart-grid">
        <div className="oo-panel" style={{ marginBottom: 0 }}>
          <div className="oo-toolbar" style={{ borderBottom: 0, paddingBottom: 8 }}>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "g2048", label: "2048" },
                { value: "snake", label: "贪吃蛇" },
                { value: "online", label: "P2P 对局" },
              ]}
            />
          </div>
          <div style={{ padding: "0 14px 14px" }}>
            {tab === "g2048" ? <G2048 onScore={submitScore} focusRef={focusRef} /> : null}
            {tab === "snake" ? <SnakeGame onScore={submitScore} focusRef={focusRef} /> : null}
            {tab === "online" ? <OnlineGame me={me} toast={toast} /> : null}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tab !== "online" ? (
            <div className="oo-panel" style={{ marginBottom: 0 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
                <div className="oo-stats-card-title"><TrophyOutlined /> 排行榜</div>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>每人只取最高分</span>
              </div>
              {boardLoading && !board.items.length ? (
                <Skeleton active paragraph={{ rows: 3 }} />
              ) : !board.items.length ? (
                <Empty description="还没有成绩，玩一局上榜" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <div>
                  {board.items.slice(0, 10).map((it) => (
                    <div key={it.user_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
                      <span
                        className="oo-num"
                        style={{ width: 18, color: it.rank <= 3 ? "var(--accent-ink)" : "var(--ink-3)", fontWeight: it.rank <= 3 ? 600 : 400 }}
                      >
                        {it.rank <= 3 ? <CrownOutlined /> : it.rank}
                      </span>
                      <UserAvatar user={{ id: it.user_id, username: it.username, display_name: it.display_name, avatar_url: it.avatar_url }} size={20} />
                      <a onClick={() => navigate(`/u/${it.user_id}`)} className="oo-truncate" style={{ flex: 1, cursor: "pointer", color: it.is_me ? "var(--accent-ink)" : "inherit" }}>
                        {it.display_name || it.username}
                        {it.is_me ? "（我）" : ""}
                      </a>
                      <span className="oo-num" style={{ fontWeight: 600 }}>{it.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div className="oo-panel" style={{ marginBottom: 0 }}>
            <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
              <div className="oo-stats-card-title"><ThunderboltOutlined /> 玩法</div>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.9 }}>
              {tab === "g2048" ? (
                <>
                  <div>· 方向键或 WASD 移动方块（需先点击棋盘）</div>
                  <div>· 相同数字相撞合并，目标是凑出 2048</div>
                  <div>· 键盘只在棋盘获焦时生效，不会影响页面滚动</div>
                </>
              ) : tab === "snake" ? (
                <>
                  <div>· 方向键或 WASD 控制蛇移动（需先点击棋盘）</div>
                  <div>· 吃到方块得 10 分，撞墙或咬到自己结束</div>
                </>
              ) : (
                <>
                  <div>· 创建房间等待对手，或加入公开对局</div>
                  <div>· 五子棋先连成五子者胜；井字棋三连线者胜</div>
                  <div>· **胜负由服务端判定**，客户端只提交落子坐标</div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
