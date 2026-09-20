// Playground —— 联机对战游戏大厅
// ---------------------------------------------------------------------------
// 定位（延续 Gemini 的 Terminal Arcade 建议）：不是「小游戏集合」，
// 而是**联机棋牌室**。所以这一版彻底去掉了单机 2048/贪吃蛇（用户明确不要：
// 没人玩），只留真人对战 —— 有对手才有留存的理由。
//
// 视觉：全部用设计系统变量，棋盘 --surface/--line（1px 细线），
// 棋子只用 --ink 与 --accent 单色扁平，排行榜复用 RankBar（与模型用量排行一致）。
//
// 六种游戏共用一个渲染框架，差异由各引擎的 meta.render / meta.click 决定：
//   · grid-stone：格子棋盘（四子棋/黑白棋/五子棋/跳棋）
//   · xiangqi   ：象棋（带汉字棋子与九宫/河界标注）
//   · battleship：海战棋（双棋盘，对手盘是迷雾）
// 这样加新游戏只需实现引擎 + 一个渲染分支，不用复制整套对战 UI。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button, Space, Tag, Empty, App as AntApp, Segmented, List, Tooltip, Skeleton, Popconfirm, Badge,
} from "antd";
import {
  ReloadOutlined, GlobalOutlined, PlayCircleOutlined, PlusOutlined,
  ThunderboltOutlined, SwapOutlined, CheckOutlined,
} from "@ant-design/icons";
import { API } from "../services/api";
import { useApp } from "../context/AppContext";
import useLatest from "../hooks/useLatest";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import UserAvatar from "../components/UserAvatar";

/* ===========================================================================
   棋盘渲染器
   =========================================================================== */

/** 棋子配色：1 = 房主（黑/实心），2 = 客方（主色/空心） */
const SIDE_STYLE = {
  1: { bg: "var(--ink)", border: "var(--ink)", label: "●" },
  2: { bg: "var(--accent)", border: "var(--accent)", label: "○" },
};

/** 通用格子棋盘（四子棋 / 黑白棋 / 五子棋 / 跳棋） */
function GridBoard({ room, onCell, onSelect, selected }) {
  const { rows, cols, cell } = room.meta || {};
  const legalTargets = useMemo(() => {
    const set = new Set();
    for (const m of room.legal || []) {
      if (m.from !== undefined && selected !== null && m.from !== selected) continue;
      if (m.to !== undefined) set.add(Number(m.to));
      else if (m.col !== undefined) set.add(`col:${m.col}`);
    }
    return set;
  }, [room.legal, selected]);
  const myPieces = useMemo(() => {
    const set = new Set();
    for (const m of room.legal || []) set.add(Number(m.from));
    return set;
  }, [room.legal]);

  const cellCls = (v) => {
    if (v === 1) return "is-a";
    if (v === 2) return "is-b";
    return "";
  };

  /** 棋子外观：跳棋用「王」标记，其余实心/空心圆 */
  const renderPiece = (v) => {
    if (!v) return null;
    const side = v % 2 === 1 ? 1 : 2; // 跳棋编码
    const st = SIDE_STYLE[side] || SIDE_STYLE[1];
    const isKing = v >= 3;
    if (cell === "checker") {
      return (
        <span
          style={{
            width: "68%", height: "68%", borderRadius: "50%",
            background: side === 1 ? "var(--ink)" : "var(--accent)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--surface)", fontSize: 10, fontWeight: 700,
          }}
        >
          {isKing ? "王" : ""}
        </span>
      );
    }
    return (
      <span
        style={{
          width: "72%", height: "72%", borderRadius: "50%",
          background: st.bg,
          border: cell === "disc" && side === 2 ? "2px solid var(--surface)" : "none",
          display: "block",
        }}
      />
    );
  };

  if (!rows || !cols) return <Empty description="棋盘数据缺失" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  return (
    <div
      className="oo-game-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        width: "100%",
        height: "100%",
      }}
    >
      {(room.board || []).map((v, i) => {
        const playable = room.my_turn && (room.meta?.click === "cell" ? legalTargets.has(i) || !v : myPieces.has(i));
        return (
          <span
            key={i}
            className={`oo-game-cell ${cellCls(v)}`}
            role={playable ? "button" : undefined}
            aria-label={playable ? `落子位置 ${i}` : undefined}
            onClick={() => {
              if (!room.my_turn) return;
              if (room.meta?.click === "column") return; // 由外层按列处理
              if (room.meta?.click === "from-to") onCell?.(i);
              else onCell?.(i);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: playable ? "pointer" : "default",
              background: i === room.lastPos ? "var(--accent-tint)" : undefined,
              outline: selected === i ? "2px solid var(--accent)" : undefined,
              outlineOffset: -2,
            }}
            title={i === room.lastPos ? "对方/你最近的一步" : undefined}
          >
            {renderPiece(v)}
          </span>
        );
      })}
    </div>
  );
}

/** 四子棋：按列落子（棋子受重力，点列即可） */
function ColumnBoard({ room, onColumn }) {
  const { rows, cols } = room.meta || {};
  const board = room.board || [];
  // 每列顶部叠一个可点区域（点任意行都落到该列）
  return (
    <div
      className="oo-game-grid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, width: "100%", height: "100%" }}
    >
      {Array.from({ length: rows * cols }, (_, i) => {
        const x = i % cols;
        const y = Math.floor(i / cols);
        const v = board[i];
        return (
          <span
            key={i}
            className="oo-game-cell"
            onClick={() => room.my_turn && onColumn?.(x)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: room.my_turn && y === 0 ? "pointer" : "default",
              background: i === room.lastPos ? "var(--accent-tint)" : undefined,
              borderBottom: y === rows - 1 ? "2px solid var(--line-strong)" : "1px solid var(--line)",
            }}
          >
            {v ? (
              <span
                style={{
                  width: "76%", height: "76%", borderRadius: "50%",
                  background: v === 1 ? "var(--ink)" : "var(--accent)",
                  display: "block",
                }}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** 象棋：带汉字棋子 + 九宫/河界提示 */
const XIANGQI_CHAR = {
  1: { 1: "将", 2: "士", 3: "象", 4: "马", 5: "车", 6: "炮", 7: "卒" },
  "-1": { 1: "帅", 2: "仕", 3: "相", 4: "马", 5: "车", 6: "炮", 7: "兵" },
};

function XiangqiBoard({ room, onCell, selected }) {
  const { rows, cols } = room.meta || {};
  const board = room.board || [];
  const legalTargets = useMemo(() => {
    const set = new Set();
    for (const m of room.legal || []) {
      if (selected === null || m.from === selected) set.add(m.to);
    }
    return set;
  }, [room.legal, selected]);

  return (
    <div
      className="oo-game-grid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, width: "100%", height: "100%" }}
    >
      {board.map((v, i) => {
        const x = i % cols;
        const y = Math.floor(i / cols);
        const isBlackPiece = v > 0;
        const kind = Math.abs(v);
        const ch = v ? XIANGQI_CHAR[isBlackPiece ? 1 : "-1"][kind] : "";
        const playable = room.my_turn && (v === 0 ? legalTargets.has(i) : legalTargets.has(i) || (selected === null && room.legal?.some((m) => m.from === i)));
        return (
          <span
            key={i}
            className="oo-game-cell"
            onClick={() => room.my_turn && onCell?.(i)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: playable ? "pointer" : "default",
              border: "1px solid var(--line)",
              background:
                i === room.lastPos ? "var(--accent-tint)" : legalTargets.has(i) && selected !== null ? "color-mix(in srgb, var(--accent) 10%, transparent)" : undefined,
              // 河界：第 5 行上边线加粗（黑方河界），帮助定位
              borderTop: y === 5 ? "2px solid var(--line-strong)" : undefined,
              position: "relative",
            }}
            title={`${x},${y}`}
          >
            {v ? (
              <span
                style={{
                  width: "86%", height: "86%", borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--surface)",
                  border: `1.5px solid ${isBlackPiece ? "var(--ink)" : "var(--red)"}`,
                  color: isBlackPiece ? "var(--ink)" : "var(--red)",
                  fontSize: "clamp(9px, 1.6vw, 15px)",
                  fontWeight: 600,
                  userSelect: "none",
                  outline: selected === i ? "2px solid var(--accent)" : undefined,
                }}
              >
                {ch}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** 海战棋：双棋盘（自己的完整可见、对手的是迷雾） */
function BattleshipBoards({ room, onFire }) {
  const { rows, cols, ships } = room.meta || {};
  const R = rows || 10;
  const C = cols || 10;
  const placing = room.phase === "placing";

  const boardStyle = {
    display: "grid",
    gridTemplateColumns: `repeat(${C}, 1fr)`,
    gridTemplateRows: `repeat(${R}, 1fr)`,
    gap: 1,
    background: "var(--line)",
    border: "1px solid var(--line)",
    aspectRatio: "1 / 1",
    width: "100%",
  };

  /** 我方棋盘：0 空 / 1 被击中 / 2 对方打空 / 3 我方舰体 */
  const myCellStyle = (v) => {
    if (v === 1) return { background: "var(--red)", opacity: 0.85 }; // 被击中
    if (v === 2) return { background: "var(--inset)" }; // 对方打空
    if (v === 3) return { background: "var(--ink-3)" }; // 我方舰体
    return { background: "var(--surface)" };
  };
  /** 对手棋盘：-1 未知 / 1 命中 / 2 打空 */
  const foeCellStyle = (v) => {
    if (v === -1) return { background: "var(--inset)" }; // 未探明
    if (v === 1) return { background: "var(--red)", opacity: 0.85 };
    return { background: "var(--surface)" }; // 打空
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center", width: "100%" }}>
      <div style={{ flex: "1 1 260px", maxWidth: 340 }}>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>
          我方海域（{room.placed || 0}/{ships?.length || 5} 舰已布）
        </div>
        <div style={boardStyle}>
          {(room.myBoard || []).map((v, i) => (
            <span key={i} style={myCellStyle(v)} title={`${i % C},${Math.floor(i / C)}`} />
          ))}
        </div>
      </div>
      <div style={{ flex: "1 1 260px", maxWidth: 340 }}>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>
          对方海域（点击炮击 · 剩余 {room.foeAlive ?? "?"} 舰）
        </div>
        <div style={boardStyle}>
          {(room.foeBoard || []).map((v, i) => (
            <span
              key={i}
              role={room.my_turn && v === -1 ? "button" : undefined}
              onClick={() => !placing && room.my_turn && v === -1 && onFire?.(i)}
              style={{
                ...foeCellStyle(v),
                cursor: !placing && room.my_turn && v === -1 ? "crosshair" : "default",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, color: "var(--surface)",
              }}
              title={v === 1 ? "命中" : v === 2 ? "打空" : `${i % C},${Math.floor(i / C)}`}
            >
              {v === 1 ? "×" : v === 2 ? "·" : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ===========================================================================
   对战面板（六种游戏共用）
   =========================================================================== */
function GameRoom({ room, me, toast, onUpdate, onLeave, onJoin }) {
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const meta = room.meta || {};

  const act = async (action, payload) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await API.post(`/games/rooms/${room.id}/action`, { action, payload });
      onUpdate(r);
      if (r.status === "finished") {
        toast.success(r.winner_id ? (Number(r.winner_id) === Number(me?.id) ? "你赢了 🎉" : "你输了") : "平局");
      } else if (r.note) {
        toast.info(r.note);
      }
    } catch (e) {
      toast.error(e.message);
      // 冲突（409）时刷新一次，避免界面停在旧状态
      if (e.status === 409) onLeave?.("refresh");
    } finally {
      setBusy(false);
    }
  };

  /** from-to 类游戏（跳棋/象棋）：先选自己的子，再点目标 */
  const handleCell = (i) => {
    if (meta.click !== "from-to") {
      act("move", { position: i });
      return;
    }
    const mine = (room.legal || []).some((m) => m.from === i);
    if (selected === null) {
      if (!mine) return;
      setSelected(i);
      return;
    }
    if (i === selected) {
      setSelected(null);
      return;
    }
    const ok = (room.legal || []).some((m) => m.from === selected && m.to === i);
    if (!ok) {
      // 点回自己的另一枚子 = 换选；否则提示
      if (mine) setSelected(i);
      else toast.warning("这一步走不了");
      return;
    }
    setSelected(null);
    act("move", { from: selected, to: i });
  };

  const handleColumn = (col) => act("move", { col });

  const placing = room.phase === "placing";
  const myReady = placing && room.ready?.[room.my_side];

  const statusText = () => {
    if (room.status === "waiting") return "等待对手加入";
    if (room.status === "finished") return room.winner_id ? (Number(room.winner_id) === Number(me?.id) ? "你赢了" : "你输了") : "平局";
    if (placing) return myReady ? "已准备，等待对手布阵" : "布阵阶段：请摆放舰船";
    return room.my_turn ? "轮到你" : "等待对手";
  };

  return (
    <div className="oo-game-stage">
      <div className="oo-game-hud">
        <Tag color={room.status === "finished" ? undefined : room.my_turn ? "green" : "default"}>{statusText()}</Tag>
        <span>
          你执 {room.my_side === 1 ? "先手" : room.my_side === 2 ? "后手" : "观战"}
          {room.my_side === 1 ? "（房主）" : ""}
        </span>
        {room.note ? <span style={{ color: "var(--accent-ink)" }}>{room.note}</span> : null}
        <Space>
          {room.status === "waiting" ? (
            <Button size="small" type="primary" disabled={room.my_side === 1} onClick={() => onJoin?.(room.id)}>
              加入对局
            </Button>
          ) : null}
          {placing && !myReady ? (
            <>
              <Tooltip title="随机摆放全部舰船">
                <Button size="small" icon={<SwapOutlined />} onClick={() => act("auto")}>
                  随机布阵
                </Button>
              </Tooltip>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => act("ready")}
                disabled={(room.placed || 0) < (meta.ships?.length || 5)}
              >
                准备完毕
              </Button>
            </>
          ) : null}
          {room.status === "playing" ? (
            <Popconfirm title="认输？" onConfirm={() => act("resign")} okText="认输" okType="danger" cancelText="取消">
              <Button size="small" danger>认输</Button>
            </Popconfirm>
          ) : null}
          <Button size="small" onClick={() => onLeave?.("back")}>返回大厅</Button>
        </Space>
      </div>

      {/* 布阵阶段提示（海战棋） */}
      {placing && !myReady ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
          点「随机布阵」快速开局，或按「航母 5 / 战列舰 4 / 巡洋舰 3 / 潜艇 3 / 驱逐舰 2」依次摆放
        </div>
      ) : null}

      <div className="oo-game-canvas" style={{ maxWidth: meta.render === "battleship" ? 720 : 520, aspectRatio: "1 / 1" }}>
        {meta.render === "battleship" ? (
          <div style={{ padding: 8, height: "100%", overflow: "auto" }}>
            <BattleshipBoards room={room} onFire={(i) => act("move", { position: i })} />
          </div>
        ) : meta.click === "column" ? (
          <ColumnBoard room={room} onColumn={handleColumn} />
        ) : meta.render === "xiangqi" ? (
          <XiangqiBoard room={room} onCell={handleCell} selected={selected} />
        ) : (
          <GridBoard room={room} onCell={handleCell} selected={selected} />
        )}
      </div>

      {/* 对局双方 */}
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--ink-3)", flexWrap: "wrap", justifyContent: "center" }}>
        <span>
          先手 #{room.host_id} {room.my_side === 1 ? "（你）" : ""} {room.turn_user_id === room.host_id && room.status === "playing" ? "· 行棋中" : ""}
        </span>
        <span>
          后手 #{room.guest_id || "—"} {room.my_side === 2 ? "（你）" : ""} {room.turn_user_id === room.guest_id && room.guest_id && room.status === "playing" ? "· 行棋中" : ""}
        </span>
        <span>对局 #{room.id}</span>
      </div>
    </div>
  );
}

/* ===========================================================================
   页面
   =========================================================================== */
export default function GamesPage() {
  const navigate = useNavigate();
  const { message: toast } = AntApp.useApp();
  const { user: me } = useApp();
  const { begin, isLatest } = useLatest();

  const [games, setGames] = useState([]);
  const [gameKey, setGameKey] = useState("");
  const [rooms, setRooms] = useState([]);
  const [myRooms, setMyRooms] = useState([]);
  const [room, setRoom] = useState(null);
  const [loading, setLoading] = useState(false);
  const esRef = useRef(null);

  const loadGames = useCallback(async () => {
    try {
      const d = await API.get("/games/list");
      const list = Array.isArray(d) ? d : [];
      setGames(list);
      setGameKey((prev) => prev || list[0]?.key || "");
    } catch (e) {
      toast.error(e.message);
    }
  }, [toast]);

  const loadRooms = useCallback(async () => {
    const token = begin();
    setLoading(true);
    try {
      const [r, my] = await Promise.all([
        API.get("/games/rooms", { params: { game_key: gameKey || undefined } }),
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
    loadGames();
  }, [loadGames]);
  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  // SSE：对手落子/加入后立即更新（服务端按各自视角推送，隐藏信息不会串）
  useEffect(() => {
    let closed = false;
    let es = null;
    (async () => {
      try {
        const { ticket } = await API.post("/chatroom/stream-ticket", {});
        if (closed) return;
        es = new EventSource(`/api/chatroom/stream?ticket=${encodeURIComponent(ticket)}`);
        esRef.current = es;
        const onUpdate = (ev) => {
          try {
            const d = JSON.parse(ev.data);
            setRoom((prev) => (prev && Number(prev.id) === Number(d.id) ? d : prev));
            loadRooms();
          } catch {
            /* ignore */
          }
        };
        es.addEventListener("game_move", onUpdate);
        es.addEventListener("game_joined", onUpdate);
      } catch {
        /* 无实时也能玩（可手动刷新） */
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
    if (!gameKey) return;
    try {
      const r = await API.post("/games/rooms", { game_key: gameKey });
      setRoom(r);
      toast.success("房间已创建，等待对手加入");
      loadRooms();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const joinRoom = async (id) => {
    try {
      const r = await API.post(`/games/rooms/${id}/join`);
      setRoom(r);
      toast.success("已加入对局");
      loadRooms();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const currentGame = games.find((g) => g.key === gameKey);

  return (
    <div className="oo-page">
      <PageHeader
        title="Playground"
        tags={<Tag icon={<GlobalOutlined />}>联机对战</Tag>}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={loadRooms} loading={loading} title="刷新" aria-label="刷新对局列表" />
            <Button type="primary" icon={<PlusOutlined />} onClick={createRoom} disabled={!gameKey || Boolean(room)}>
              创建房间
            </Button>
          </>
        }
      />

      {/* 汇总：紧凑统计卡（全站统一形态） */}
      <div className="oo-stats-cards">
        <StatCard label="可玩玩法" value={games.length} suffix="种" hint="全部为真人对战" />
        <StatCard label="等待中房间" value={rooms.filter((r) => r.status === "waiting").length} suffix="个" hint="可直接加入" />
        <StatCard label="进行中" value={rooms.filter((r) => r.status === "playing").length} suffix="局" hint="可观战" />
        <StatCard label="我的对局" value={myRooms.length} suffix="局" hint="未结束的对局" />
      </div>

      {room ? (
        <div className="oo-panel">
          <div className="oo-panel-head" style={{ paddingBottom: 4 }}>
            <span className="oo-panel-title">
              {room.game_name} · 对局 #{room.id}
            </span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{room.brief}</span>
          </div>
          <div className="oo-panel-body">
            <GameRoom
              room={room}
              me={me}
              toast={toast}
              onUpdate={(r) => {
                setRoom(r);
                loadRooms();
              }}
              onJoin={joinRoom}
              onLeave={(why) => {
                setRoom(null);
                if (why === "refresh") loadRooms();
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="oo-chart-grid">
        <div className="oo-panel" style={{ marginBottom: 0 }}>
          <div className="oo-toolbar" style={{ borderBottom: 0, paddingBottom: 8 }}>
            <Segmented
              value={gameKey}
              onChange={setGameKey}
              options={games.map((g) => ({ value: g.key, label: g.name }))}
            />
          </div>
          <div style={{ padding: "0 14px 6px", fontSize: 12, color: "var(--ink-3)" }}>
            {currentGame ? currentGame.brief : ""}
          </div>
          <div style={{ padding: "0 14px 14px" }}>
            {loading && !rooms.length ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : !rooms.length ? (
              <Empty
                description={
                  <span>
                    当前没有「{currentGame?.name || "该玩法"}」的公开房间
                    <br />
                    点右上角「创建房间」，等对手加入
                  </span>
                }
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
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
                        <Button size="small" icon={<PlayCircleOutlined />} onClick={() => openRoom(r.id)}>
                          {r.is_mine ? "回到对局" : "观战"}
                        </Button>
                      ),
                    ]}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <Tag>{r.game_name}</Tag>
                      <span className="oo-truncate" style={{ fontSize: 12.5 }}>
                        {r.host_name || `用户 #${r.host_id}`}
                        {r.guest_id ? ` vs ${r.guest_name || `用户 #${r.guest_id}`}` : " vs 等待对手"}
                      </span>
                      <Tag color={r.status === "waiting" ? "orange" : "green"}>
                        {r.status === "waiting" ? "等待中" : r.phase === "placing" ? "布阵中" : "对局中"}
                      </Tag>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {myRooms.length ? (
            <div className="oo-panel" style={{ marginBottom: 0 }}>
              <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
                <div className="oo-stats-card-title"><SwapOutlined /> 我的对局</div>
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>点击继续</span>
              </div>
              {myRooms.map((r) => (
                <div
                  key={r.id}
                  className="oo-post-item"
                  style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}
                  onClick={() => openRoom(r.id)}
                >
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

          <div className="oo-panel" style={{ marginBottom: 0 }}>
            <div className="oo-stats-card-head" style={{ marginBottom: 8 }}>
              <div className="oo-stats-card-title"><ThunderboltOutlined /> 玩法与规则</div>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.9 }}>
              <div>· 创建房间后把链接给对手，或让对方在左侧列表点「加入」</div>
              <div>· **胜负与合法性全部由服务端判定**，客户端只提交走子意图</div>
              <div>· 观战：对局默认允许观战（海战棋观战看不到双方布阵）</div>
              <div>· 离开页面不影响对局，回来点「我的对局」继续</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
