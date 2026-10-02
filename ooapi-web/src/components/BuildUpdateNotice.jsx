import React, { useEffect, useRef, useState } from "react";
import { App as AntApp, Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useApp } from "../context/AppContext";

function loadedBuildId() {
  const src = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute("src");
  return src?.match(/index-[A-Za-z0-9_-]+\.js/)?.[0] || "";
}

function Countdown({ onDone }) {
  const [seconds, setSeconds] = useState(10);
  useEffect(() => {
    // 用截止时间计时，避免后台标签页节流导致「十秒」变成几十秒。
    const deadline = Date.now() + 10_000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(left);
      if (!left) { clearInterval(timer); onDone(); }
    }, 200);
    return () => clearInterval(timer);
  }, [onDone]);
  return <div className="oo-update-countdown">
    <p>新版本已就绪，{seconds} 秒后自动刷新。</p>
    <Button size="small" icon={<ReloadOutlined />} onClick={onDone}>立即刷新</Button>
    <div className="oo-update-progress" role="progressbar" aria-label="自动刷新倒计时" aria-valuemin={0} aria-valuemax={10} aria-valuenow={seconds}><i /></div>
  </div>;
}

const reload = () => window.location.reload();

export default function BuildUpdateNotice() {
  const { status, refreshStatus } = useApp();
  const { notification } = AntApp.useApp();
  const seen = useRef("");
  useEffect(() => {
    const onFocus = () => refreshStatus();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(onFocus, 60_000);
    return () => { window.removeEventListener("focus", onFocus); clearInterval(timer); };
  }, [refreshStatus]);
  useEffect(() => {
    const mine = loadedBuildId();
    const next = status?.build_id;
    if (!mine || !next || next === mine || seen.current === next) return;
    seen.current = next;
    notification.open({
      key: "ooapi-build-update", placement: "topRight", duration: 0,
      className: "oo-update-notice", message: "页面版本已更新",
      icon: <ReloadOutlined style={{ color: "var(--accent)" }} />,
      description: <Countdown key={next} onDone={reload} />,
      closeIcon: false,
    });
  }, [status?.build_id, notification]);
  return null;
}
