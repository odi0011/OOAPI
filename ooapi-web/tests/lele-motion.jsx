import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, Button, ConfigProvider, Select } from "antd";
import ChatMascot from "../src/components/ChatMascot";
import ComposerCompanion from "../src/components/ComposerCompanion";
import ChatScene from "../src/components/ChatScene";
import "../src/components/chat-workspace.css";
import "./lele-motion.css";

const POSES = [
  "peek", "curious", "listen", "shy", "wave", "invite", "paws", "look",
  "cute", "proud", "pop", "walk", "spin", "chase", "toy", "belly", "lick",
  "groom", "wash", "stretch", "wink", "curl", "sleep", "zzz", "knead",
  "shake", "loaf", "yawn", "drowsy", "pawtap", "drape", "side-peek",
  "side-scout", "side-paw", "side-tap", "tail-slip", "tail-tip", "feet-kick", "foot-dangle",
];
const BUSINESS_STATES = [
  "idle", "attentive", "thinking", "working", "loading", "compressing",
  "waiting", "asking", "success", "sad",
];
const GALLERY_STATES = ["idle", "thinking", "working", "asking", "success", "sad"];
const GRIP_POSES = new Set(["paws", "wave", "invite", "listen", "knead"]);
const ACTIONS = ["send", "copy", "retry", "attach"];
const PREVIEW_APPROVAL = {
  id: "preview-approval",
  name: "预览动作",
  presentation: {
    title: "预览动作",
    description: "这是一条不会提交到服务端的演示询问。",
    scope: "只在此预览中展示",
    fields: [],
  },
};
const optionsFor = values => values.map(value => ({ value, label: value }));
const signalAction = action => window.dispatchEvent(new CustomEvent("lele-action", { detail: action }));

function MotionDirector({ state, pose, phase, replayKey, onPhaseChange }) {
  const isSide = pose.startsWith("side-");
  const isBottom = /^(tail|feet|foot)-/.test(pose);
  const isFragment = isSide || isBottom;
  const edge = isSide ? "left" : isBottom ? "bottom" : "top";
  const anchorClasses = [
    "lele-perch-anchor", `at-${edge}`, `pose-${pose}`, `phase-${phase}`,
    isFragment && "is-fragment",
  ].filter(Boolean).join(" ");
  const finishEntry = event => {
    if (event.target.classList.contains("lele-edge-actor") && phase === "enter") {
      onPhaseChange(isFragment ? "hidden" : "rest");
    }
  };

  return <section className="director" data-pose={pose} data-phase={phase}>
    <span className="label">姿态与状态 · 可随时切换</span>
    <div className="perch-demo">
      <span
        className={anchorClasses}
        data-pose={pose}
        data-phase={phase}
        style={{ left: isSide ? 0 : "55%", top: isSide ? 36 : undefined, "--drape-run-x": "-60px" }}
        onAnimationEnd={finishEntry}
      >
        <span className="lele-edge-viewport">
          <span key={replayKey} className="lele-edge-actor"><ChatMascot state={state} gesture={pose}/></span>
        </span>
        {GRIP_POSES.has(pose) && <span className="lele-edge-grip"><i/><i/></span>}
      </span>
      <p>动作在框沿发生，身体与文字保持各自的空间。</p>
    </div>
  </section>;
}

function LiveComposerPreview({ state }) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [approvalVisible, setApprovalVisible] = useState(false);
  const input = useRef(null);
  const changeText = event => {
    setText(event.target.value);
    signalAction("typing");
  };

  return <section className="live">
    <span className="label">真实输入框交互 · 试试停留抚摸、连续输入和快速切换菜单</span>
    <div className="bui-composer">
      <ComposerCompanion
        state={state}
        inputValue={text}
        inputRef={input}
        menuOpen={menu}
        approvals={approvalVisible ? [PREVIEW_APPROVAL] : []}
        onDecide={() => setApprovalVisible(false)}
      />
      <textarea aria-label="消息内容" ref={input} value={text} onChange={changeText} placeholder="写点什么，乐乐在听…"/>
      <div className="bar">
        <Button onClick={() => setMenu(value => value === "model" ? "reason" : "model")}>切换菜单</Button>
        <Button onClick={() => setMenu(false)}>关闭菜单</Button>
        <Button onClick={() => setApprovalVisible(value => !value)}>询问</Button>
        {ACTIONS.map(action => <Button key={action} onClick={() => signalAction(action)}>{action}</Button>)}
      </div>
      {menu && <div data-promptbar-menu className="test-menu" style={{ height: menu === "model" ? 200 : 100 }}>
        <b>{menu === "model" ? "选择模型" : "推理强度"}</b>
        <p>乐乐会避开挡住它的菜单，落在真实上沿。</p>
      </div>}
    </div>
  </section>;
}

function StateGallery() {
  return <section className="gallery">
    <span className="label">日常片段</span>
    <div className="tiles">
      {GALLERY_STATES.map(state => <div className="tile" key={state}>
        <ChatMascot state={state}/><span>{state}</span>
      </div>)}
    </div>
  </section>;
}

function Preview() {
  const [state, setState] = useState("idle");
  const [pose, setPose] = useState("peek");
  const [phase, setPhase] = useState("rest");
  const [dark, setDark] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const changePose = value => { setPose(value); setPhase("rest"); };
  const replay = nextPhase => { setReplayKey(value => value + 1); setPhase(nextPhase); };

  return <main data-dark={dark} className={paused ? "is-paused" : undefined}>
    <header>
      <span>OOAPI / LELE</span>
      <h1>乐乐 · 动作试映</h1>
      <p>原来的灰白小猫，重新学习如何陪在你身边。</p>
    </header>
    <section className="controls">
      <Select showSearch virtual={false} aria-label="业务状态" value={state} onChange={setState} options={optionsFor(BUSINESS_STATES)}/>
      <Select showSearch virtual={false} aria-label="动作" value={pose} onChange={changePose} options={optionsFor(POSES)}/>
      <Button onClick={() => replay("enter")}>重播入场</Button>
      <Button onClick={() => replay("rest")}>重播姿态</Button>
      <Button onClick={() => setPhase("exit")}>收回</Button>
      <Button onClick={() => setPhase("startle")}>侧卧惊醒</Button>
      <Button onClick={() => setPhase("stretch")}>侧卧伸展</Button>
      <Button onClick={() => setDark(value => !value)}>切换明暗</Button>
      <Button aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? "继续动画" : "静止展示"}</Button>
    </section>
    <MotionDirector state={state} pose={pose} phase={phase} replayKey={replayKey} onPhaseChange={setPhase}/>
    <LiveComposerPreview state={state}/>
    <StateGallery/>
    <ChatScene/>
  </main>;
}

createRoot(document.getElementById("root")).render(
  <ConfigProvider><App><Preview/></App></ConfigProvider>,
);
