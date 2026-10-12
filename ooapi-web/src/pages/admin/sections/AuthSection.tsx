import { useCallback, useEffect, useState } from "react";

import Badge from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import Switch from "@/components/arc/switch/switch";
import { ApiRequestError, apiRequest } from "@/lib/api";
import HoldToConfirm from "@/components/arc/hold-to-confirm/hold-to-confirm";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import sectionStyles from "./Section.module.css";
import styles from "./AuthSection.module.css";

interface ProviderState {
  key: string;
  display_name: string;
  enabled: boolean;
  configured: boolean;
  client_id: string;
  secret_masked: string;
  callback_url: string;
  use_pkce: boolean;
}

interface SMTPState {
  host: string;
  port: number;
  username: string;
  password_masked: string;
  from: string;
  from_name: string;
  use_tls: boolean;
  configured: boolean;
  enabled: boolean;
}

interface AuthConfig {
  providers: ProviderState[];
  smtp: SMTPState;
  switches: { password_login_enabled: boolean; password_register_enabled: boolean };
  site_base_url: string;
  detected_base_url: string;
}

/** 每个平台的折叠状态与编辑草稿。 */
type Draft = Record<string, { clientId: string; clientSecret: string; enabled: boolean }>;

/**
 * 登录与注册分区。
 *
 * 与站点设置同处一页 —— 它本来就是「站点配置」的一部分，
 * 单独开一个页面会让管理员在几处之间来回找。
 *
 * 这个分区有自己的保存按钮：它读写的是另一个接口
 * （/api/admin/auth-config），与站点设置的表单不同源，
 * 混在一个保存动作里容易把密钥掩码当成新密钥写回去。
 */
export default function AuthSection({ actionGuard }: { actionGuard?: ReturnType<typeof useAsyncGuard> }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [smtp, setSMTP] = useState<SMTPState | null>(null);
  const [smtpPassword, setSMTPPassword] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 操作反馈走全局 toast
  const notify = useNotify();
  const localAction = useAsyncGuard();
  const action = actionGuard ?? localAction;
  const [testing, setTesting] = useState(false);
  /** 配置加载失败是页面级问题，内联常驻；其余走 toast。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<AuthConfig>("/api/admin/auth-config");
      setConfig(data);
      setSMTP(data.smtp);

      const next: Draft = {};
      for (const p of data.providers) {
        next[p.key] = { clientId: p.client_id, clientSecret: "", enabled: p.enabled };
      }
      setDraft(next);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!config || !smtp || !action.acquire()) return;
    setSaving(true);

    try {
      const res = await apiRequest<{ providers: ProviderState[]; smtp: SMTPState }>(
        "/api/admin/auth-config",
        {
          method: "PUT",
          body: {
            providers: config.providers.map((p) => ({
              key: p.key,
              client_id: draft[p.key]?.clientId ?? "",
              // 留空表示保持原值，避免把掩码写进库
              client_secret: draft[p.key]?.clientSecret ?? "",
              enabled: draft[p.key]?.enabled ?? false,
            })),
            smtp: {
              host: smtp.host,
              port: smtp.port,
              username: smtp.username,
              password: smtpPassword,
              from: smtp.from,
              from_name: smtp.from_name,
              use_tls: smtp.use_tls,
              enabled: smtp.enabled,
            },
          },
        },
      );

      notify.success("登录与注册配置已保存");
      setSMTPPassword("");
      setConfig((prev) => (prev ? { ...prev, providers: res.providers, smtp: res.smtp } : prev));
      setSMTP(res.smtp);
      setDraft(Object.fromEntries(res.providers.map((p) => [p.key, {
        clientId: p.client_id, clientSecret: "", enabled: p.enabled,
      }])));
    } catch (err) {
      notify.error("保存失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setSaving(false);
      action.release();
    }
  }

  async function testSMTP() {
    if (!testTo.trim()) {
      notify.warning("请先填写测试收件邮箱");
      return;
    }
    if (!action.acquire()) return;
    setTesting(true);
    try {
      await apiRequest("/api/admin/auth-config/test-smtp", {
        method: "POST",
        body: { to: testTo.trim() },
      });
      notify.success(`测试邮件已发送至 ${testTo.trim()}`);
    } catch (err) {
      // 发信失败原因（端口、认证、证书）对排障很关键，原样展示
      notify.error("发送失败", err instanceof ApiRequestError ? err.message : undefined);
    } finally {
      setTesting(false);
      action.release();
    }
  }

  if (loading || !config || !smtp) {
    return (
      <>
        <header className={sectionStyles.sectionHead}>
          <h2 className={sectionStyles.sectionTitle}>登录与注册</h2>
        </header>
        {loading ? (
          <p className={styles.loading}>正在加载…</p>
        ) : (
          <>
            <p className={styles.err} role="alert">{loadError ?? "加载失败"}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>重试</Button>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <header className={sectionStyles.sectionHead}>
        <h2 className={sectionStyles.sectionTitle}>登录与注册</h2>
        <p className={sectionStyles.sectionLead}>
          配置第三方登录与邮件服务。未配置的方式不会出现在登录页 ——
          填好密钥并启用后，对应入口会自动出现。密钥加密存储，留空表示不修改。
        </p>
      </header>

      {loadError && (
        <p className={styles.err} role="alert">
          {loadError}
        </p>
      )}

      {/* ---------- 第三方平台 ---------- */}
      <div className={styles.block} inert={action.busy}>
        <h3 className={styles.blockTitle}>第三方登录</h3>

        <ul className={styles.providerList}>
          {config.providers.map((p) => {
            const d = draft[p.key] ?? { clientId: "", clientSecret: "", enabled: false };
            const open = expanded === p.key;

            return (
              <li key={p.key} className={styles.provider}>
                <div className={styles.providerRow}>
                  <button
                    type="button"
                    className={styles.providerToggle}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : p.key)}
                  >
                    <span className={styles.chevron} data-open={open || undefined} aria-hidden="true">
                      ›
                    </span>
                    <strong>{p.display_name}</strong>
                    {p.enabled ? (
                      <Badge tone="success" size="sm">已启用</Badge>
                    ) : p.configured ? (
                      <Badge tone="warning" size="sm">已配置未启用</Badge>
                    ) : (
                      <Badge tone="neutral" size="sm">未配置</Badge>
                    )}
                  </button>

                  <Switch
                    label={d.enabled ? "启用" : "停用"}
                    checked={d.enabled}
                    onCheckedChange={(checked) =>
                      setDraft((prev) => ({ ...prev, [p.key]: { ...d, enabled: checked } }))
                    }
                  />
                </div>

                {/* 展开后才显示密钥输入，默认收起 —— 7 个平台全展开会有 14 个输入框，太长 */}
                {open && (
                  <div className={styles.providerBody}>
                    <div className={styles.grid2}>
                      <Input
                        label="Client ID"
                        value={d.clientId}
                        placeholder="平台申请到的 Client ID"
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [p.key]: { ...d, clientId: e.target.value } }))
                        }
                      />
                      <Input
                        label="Client Secret"
                        type="password"
                        value={d.clientSecret}
                        placeholder={p.secret_masked || "平台申请到的 Client Secret"}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [p.key]: { ...d, clientSecret: e.target.value } }))
                        }
                      />
                    </div>

                    <p className={styles.callback}>
                      回调地址（填到平台后台）
                      <code>{p.callback_url}</code>
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---------- 邮件服务 ---------- */}
      <div className={styles.block} inert={action.busy}>
        <h3 className={styles.blockTitle}>邮件服务</h3>
        <p className={styles.blockHint}>配好后登录页会出现邮箱验证码入口。</p>

        <div className={styles.grid2}>
          <Input
            label="SMTP 服务器"
            placeholder="smtp.example.com"
            value={smtp.host}
            onChange={(e) => setSMTP({ ...smtp, host: e.target.value })}
          />
          <Input
            label="端口"
            type="number"
            placeholder="587"
            value={String(smtp.port || "")}
            onChange={(e) => setSMTP({ ...smtp, port: Number(e.target.value) || 0 })}
          />
        </div>

        <div className={styles.grid2}>
          <Input
            label="账号"
            placeholder="no-reply@example.com"
            value={smtp.username}
            onChange={(e) => setSMTP({ ...smtp, username: e.target.value })}
          />
          <Input
            label="密码 / 授权码"
            type="password"
            placeholder={smtp.password_masked || "SMTP 密码或授权码"}
            value={smtpPassword}
            onChange={(e) => setSMTPPassword(e.target.value)}
          />
        </div>

        <div className={styles.grid2}>
          <Input
            label="发件人地址"
            placeholder="留空则用上面的账号"
            value={smtp.from}
            onChange={(e) => setSMTP({ ...smtp, from: e.target.value })}
          />
          <Input
            label="发件人名称"
            placeholder="OOAPI"
            value={smtp.from_name}
            onChange={(e) => setSMTP({ ...smtp, from_name: e.target.value })}
          />
        </div>

        <div className={styles.switches}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={smtp.use_tls}
              onChange={(e) => setSMTP({ ...smtp, use_tls: e.target.checked })}
            />
            <span>直连 TLS（465 端口勾选；587 端口走 STARTTLS，不勾选）</span>
          </label>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={smtp.enabled}
              onChange={(e) => setSMTP({ ...smtp, enabled: e.target.checked })}
            />
            <span>启用邮箱验证码登录</span>
          </label>
        </div>

        <div className={styles.testRow}>
          <Input
            label="测试收件邮箱"
            placeholder="you@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <Button variant="secondary" size="sm" loading={testing} disabled={action.busy} onClick={() => void testSMTP()}>
            发送测试邮件
          </Button>
        </div>
      </div>

      <div className={styles.sectionFoot}>
        <HoldToConfirm
          key={String(action.busy)}
          label={saving ? "正在保存登录配置…" : "长按保存，变更全站登录方式与邮件服务"}
          confirmed={false}
          duration={1200}
          disabled={action.busy || loading}
          onConfirm={() => void save()}
        />
        <span className={styles.footHint}>立即影响所有用户，请确保至少保留一种可用登录方式；此分区独立保存</span>
      </div>
    </>
  );
}
