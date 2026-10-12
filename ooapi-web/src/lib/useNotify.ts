import { useCallback, useMemo, useRef, useState } from "react";

import { useToastStack } from "@/components/arc/toast-stack/toast-stack";

/** 同步加锁，避免 React 更新 busy 状态前重复提交。 */
export function useAsyncGuard() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const acquire = useCallback(() => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    return true;
  }, []);
  const release = useCallback(() => {
    locked.current = false;
    setBusy(false);
  }, []);
  return { busy, acquire, release };
}

/**
 * 全站统一的操作反馈。
 *
 * 为什么要有这一层，而不是各页面直接调 useToastStack：
 *
 *   1. **文案风格统一**。同一个动作在不同页面必须说同一句话，
 *      否则用户会以为碰到了不同的功能。这里定死措辞。
 *   2. **成功与失败的呈现方式不同**。成功是「一闪而过的确认」，
 *      失败是「需要读的信息」—— 失败要停更久、带描述、允许复制原因。
 *   3. **长任务用 loading → update 的同一张卡**，而不是先弹一个
 *      「正在删除」再弹一个「删除成功」（列表里会留下两条无关记录）。
 *
 * 页面里的内联 `<p className={styles.ok}>已保存</p>` 全部改用它：
 * 内联提示固定在文档流里，用户滚到别处就看不见，
 * 而「刚才那一下成功了吗」是必须立刻看到的反馈。
 */
export function useNotify() {
  const { toast, update, dismiss } = useToastStack();

  const success = useCallback(
    (title: string, description?: string) => toast({ type: "success", title, description }),
    [toast],
  );

  const info = useCallback(
    (title: string, description?: string) => toast({ type: "info", title, description }),
    [toast],
  );

  const warning = useCallback(
    (title: string, description?: string) => toast({ type: "warning", title, description }),
    [toast],
  );

  /**
   * 失败提示。
   *
   * 错误默认停留更久（组件按类型自动延长，这里再给一个更宽松的下限）：
   * 报错信息里常带上游原文，用户需要时间读完或复制去排查。
   */
  const error = useCallback(
    (title: string, description?: string) =>
      toast({ type: "error", title, description, duration: 9000 }),
    [toast],
  );

  /**
   * 包装一个异步动作，自动呈现「进行中 → 成功 / 失败」。
   *
   * 用法：
   *   await notify.run("删除密钥", () => apiRequest(...), { success: "已删除「test」" })
   *
   * 同一个 toast id 在三种状态间原地变化 —— 用户看到的是
   * 「这一件事」的状态流转，而不是三条独立的通知。
   */
  const run = useCallback(
    async <T,>(
      pending: string,
      action: () => Promise<T>,
      opts?: { success?: string; failure?: string },
    ): Promise<T | undefined> => {
      const id = toast({ type: "loading", title: pending, duration: Infinity });
      try {
        const result = await action();
        update(id, {
          type: "success",
          title: opts?.success ?? pending + "完成",
          description: undefined,
          duration: 5000,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "未知错误";
        update(id, {
          type: "error",
          title: opts?.failure ?? pending + "失败",
          description: message,
          duration: 9000,
        });
        return undefined;
      }
    },
    [toast, update],
  );

  return useMemo(
    () => ({ success, info, warning, error, run, dismiss }),
    [success, info, warning, error, run, dismiss],
  );
}
