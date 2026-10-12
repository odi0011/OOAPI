import { useCallback, useState } from "react";

import { FileDropzone, type FileDropzoneItem } from "@/components/arc/file-dropzone/file-dropzone";
import { ApiRequestError } from "@/lib/api";

import styles from "./IconUpload.module.css";

interface IconUploadProps {
  /** 上传用途，后端据此分目录并更新对应设置项。 */
  kind: "logo" | "currency";
  /** 当前图标地址，用于预览。 */
  value: string;
  /** 上传成功后的新地址。 */
  onChange: (url: string) => void;
  /** 预览框尺寸，货币图标比站点图标小。 */
  previewSize?: number;
  label?: string;
  description?: string;
}

/**
 * 图标上传控件。
 *
 * 用组件库的 FileDropzone + 真实文件上传，而不是让管理员手填图片地址 ——
 * 手填地址要求对方先把图片传到别处，多一步且经常填错。
 */
export default function IconUpload({
  kind,
  value,
  onChange,
  previewSize = 64,
  label = "上传图标",
  description = "拖入文件，或点击选择。支持 SVG、PNG、JPG、WebP",
}: IconUploadProps) {
  const [error, setError] = useState<string | null>(null);

  /**
   * 执行真实上传。
   * FileDropzone 通过 onUpload 回调把进度上报交给我们，
   * 因此这里用 XHR 而不是 fetch —— fetch 拿不到上传进度。
   */
  const upload = useCallback(
    (item: FileDropzoneItem, options: { onProgress: (percent: number) => void; signal: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const file = item.file;
        if (!file) {
          reject(new Error("没有选中文件"));
          return;
        }

        const form = new FormData();
        form.append("kind", kind);
        form.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/admin/upload/icon");

        // 登录态在 HttpOnly cookie 里，不从脚本读取令牌。
        xhr.withCredentials = true;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            options.onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };

        xhr.onload = () => {
          let body: { success?: boolean; data?: { url?: string }; error?: { message?: string } } = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error("服务器返回了异常响应"));
            return;
          }

          if (xhr.status >= 200 && xhr.status < 300 && body.data?.url) {
            setError(null);
            onChange(body.data.url);
            resolve();
            return;
          }
          reject(new Error(body.error?.message ?? `上传失败（${xhr.status}）`));
        };

        xhr.onerror = () => reject(new Error("网络错误，上传失败"));
        xhr.onabort = () => reject(new Error("已取消"));

        options.signal.addEventListener("abort", () => xhr.abort());
        xhr.send(form);
      }),
    [kind, onChange],
  );

  return (
    <div className={styles.wrap}>
      {/* 当前图标预览：管理员上传后能立刻看到效果 */}
      <div className={styles.preview}>
        <img
          className={styles.previewImg}
          src={value || "/currency-default.svg"}
          alt="当前图标"
          style={{ width: previewSize, height: previewSize }}
        />
        <div className={styles.previewMeta}>
          <span className={styles.previewLabel}>当前图标</span>
          <code className={styles.previewPath}>{value || "内置默认图标"}</code>
        </div>
      </div>

      <FileDropzone
        accept="image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,.svg,.png,.jpg,.jpeg,.webp,.ico"
        multiple={false}
        maxFiles={1}
        maxSize={1024 * 1024}
        label={label}
        description={description}
        listPlacement="below"
        onUpload={async (item, options) => {
          try {
            await upload(item, options);
          } catch (err) {
            const msg =
              err instanceof ApiRequestError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : "上传失败";
            setError(msg);
            throw err;
          }
        }}
      />

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
