import { useCallback, useEffect, useState } from "react";

import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import Switch from "@/components/arc/switch/switch";
import { ApiRequestError, apiRequest } from "@/lib/api";
import { useNotify } from "@/lib/useNotify";

import styles from "./Section.module.css";
import local from "./UpdateSection.module.css";

interface UpdateStatus {
  repoUrl: string;
  owner: string;
  name: string;
  branch: string;
  currentSha: string;
  latestSha: string;
  latestMessage: string;
  remoteAhead: number;
  localAhead: number;
  state: string;
  autoUpdate: boolean;
  canApply: boolean;
  hint: string;
  checkedAt: string;
  lastResult: string;
}

const STATE_LABEL: Record<string, { label: string; tone: "neutral" | "success" | "info" | "warning" | "danger" }> = {
  current: { label: "已是最新", tone: "success" },
  behind: { label: "可更新", tone: "info" },
  ahead: { label: "本机超前", tone: "warning" },
  diverged: { label: "已分叉", tone: "danger" },
  updating: { label: "更新中", tone: "info" },
  unknown: { label: "未能比较", tone: "neutral" },
};

function shortSha(value: string): string {
  if (!value) return "未知";
  return value.slice(0, 7);
}

export default function UpdateSection() {
  const notify = useNotify();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setChecking(true);
    setError(null);
    try {
      const data = await apiRequest<UpdateStatus>(
        refresh ? "/api/admin/system/update?refresh=1" : "/api/admin/system/update",
      );
      setStatus(data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "读取更新状态失败");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!status?.autoUpdate) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [status?.autoUpdate, load]);

  async function setAuto(enabled: boolean) {
    setSavingAuto(true);
    try {
      const data = await apiRequest<UpdateStatus>("/api/admin/system/update", {
        method: "POST",
        body: { action: "set-auto", autoUpdate: enabled },
      });
      setStatus(data);
      notify.success(enabled ? "已开启自动更新" : "已关闭自动更新");
    } catch (err) {
      notify.error("自动更新没有保存", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSavingAuto(false);
    }
  }

  async function apply() {
    setApplying(true);
    try {
      const data = await apiRequest<UpdateStatus>("/api/admin/system/update", {
        method: "POST",
        body: { action: "apply" },
      });
      setStatus(data);
      notify.success("更新完成", data.hint || data.lastResult);
    } catch (err) {
      notify.error("更新没有完成", err instanceof ApiRequestError ? err.message : undefined);
      void load(true);
    } finally {
      setApplying(false);
    }
  }

  const state = status ? (STATE_LABEL[status.state] ?? STATE_LABEL.unknown) : null;
  const repo = status?.repoUrl || "https://github.com/odi0011/OOAPI";
  const repoLabel = status?.owner && status?.name ? `${status.owner}/${status.name}` : "odi0011/OOAPI";

  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>更新</h2>
        <p className={styles.sectionLead}>
          自动链接到 GitHub 仓库
          {" "}
          <a className={local.repoLink} href={repo} target="_blank" rel="noreferrer">{repoLabel}</a>
          {status?.branch ? ` · ${status.branch}` : ""}
          。可以现在拉到最新，也可以让服务自己跟上游。
        </p>
      </header>

      {error ? <p className={local.error} role="alert">{error}</p> : null}

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>版本</strong>
            <p>{status?.hint || (checking ? "正在对比 GitHub…" : "还没有读到版本")}</p>
          </div>
          <div className={styles.rowControl}>
            <div className={local.version}>
              {state ? <Badge tone={state.tone} size="sm">{state.label}</Badge> : null}
              <span className={local.sha}>本机 {shortSha(status?.currentSha ?? "")}</span>
              <span className={local.sha}>最新 {shortSha(status?.latestSha ?? "")}</span>
              {status?.remoteAhead ? <span className={local.sha}>落后 {status.remoteAhead}</span> : null}
            </div>
            {status?.latestMessage ? <p className={local.message}>{status.latestMessage}</p> : null}
            {status?.lastResult ? <p className={local.message}>{status.lastResult}</p> : null}
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>自动更新</strong>
            <p>开启后大约每 15 分钟检查一次。落后且可以快进时，自动拉到 GitHub 上的最新提交。</p>
          </div>
          <div className={styles.rowControlInline}>
            <Switch
              label={status?.autoUpdate ? "已开启" : "已关闭"}
              checked={status?.autoUpdate ?? false}
              disabled={savingAuto || status == null}
              onCheckedChange={(checked) => void setAuto(checked)}
            />
          </div>
        </div>

        <div className={styles.row}>
          <div className={styles.rowText}>
            <strong>手动更新</strong>
            <p>检查只询问 GitHub。更新到最新会快进源码，不会覆盖未提交的本地修改。</p>
          </div>
          <div className={local.actions}>
            <Button variant="secondary" size="sm" loading={checking} disabled={applying} onClick={() => void load(true)}>
              检查更新
            </Button>
            <HoldToConfirm
              key={String(applying)}
              label={applying ? "正在更新…" : "长按更新到最新"}
              confirmed={false}
              duration={1200}
              disabled={applying || checking || !status?.canApply}
              onConfirm={() => void apply()}
            />
          </div>
        </div>
      </div>
    </>
  );
}
