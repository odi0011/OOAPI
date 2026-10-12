import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Slider } from "@/components/arc/slider/slider";
import { apiRequest } from "@/lib/api";
import { useAsyncGuard, useNotify } from "@/lib/useNotify";

import styles from "./AvatarUploader.module.css";

export interface AvatarUploaderProps {
  open: boolean;
  onClose: () => void;
  /** 上传/移除成功后回传新的头像地址（移除且没有三方头像时是空串）。 */
  onDone: (avatarUrl: string) => void;
  /** 当前头像；只有自定义上传（/api/media/avatar 开头）才会显示「移除头像」。 */
  currentAvatar?: string;
  userName: string;
}

/** 解码后的图源：优先 ImageBitmap，退化时是已加载的 <img>。 */
type DecodedImage = ImageBitmap | HTMLImageElement;

interface MediaStats {
  max_file_bytes: number;
}

const ACCEPT = "image/png,image/jpeg,image/webp";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** 输出画布的上限边长：头像只需要 512。 */
const MAX_SIDE = 512;
/** 预览画布边长：160 的圆形取景框在 2x 屏上也够锐利。 */
const PREVIEW_SIDE = 320;
const QUALITY = 0.9;
const CUSTOM_PREFIX = "/api/media/avatar";

function sourceSize(source: DecodedImage) {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
    : { width: source.width, height: source.height };
}

/** 居中方形取景：边长 = min(w,h)/zoom，输出最多 512，白底 + JPEG 质量 0.9。 */
function renderCrop(source: DecodedImage, zoom: number, maxSide: number): HTMLCanvasElement {
  const { width, height } = sourceSize(source);
  const factor = Math.min(3, Math.max(1, zoom));
  const crop = Math.min(width, height) / factor;
  const side = Math.max(1, Math.min(Math.round(crop), MAX_SIDE, maxSide));
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, side, side);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, side, side);
  }
  return canvas;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const type = /^data:([^;,]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? "image/jpeg";
  return new Blob([bytes], { type });
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* 个别浏览器不支持该选项，退回 <img> 解码 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode_failed"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * multipart 请求。
 *
 * apiRequest 会为带 body 的请求强制 JSON Content-Type，不能用于 FormData；
 * 因此这里直接用 fetch（登录态走 cookie），并保持与 apiRequest 相同的
 * {success,data,error} 解包与错误约定（同源相对路径，与 apiRequest 一致）。
 */
export default function AvatarUploader({ open, onClose, onDone, currentAvatar, userName }: AvatarUploaderProps) {
  const notify = useNotify();
  const action = useAsyncGuard();
  const fileRef = useRef<HTMLInputElement>(null);
  const statsRef = useRef<MediaStats | null>(null);

  const [source, setSource] = useState<DecodedImage | null>(null);
  const [preview, setPreview] = useState("");
  const [zoom, setZoom] = useState(1);
  const [processing, setProcessing] = useState(false);
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [maxMB, setMaxMB] = useState<number | null>(null);

  // 大小上限只在第一次打开时取一次；拿不到就交给后端兜底。
  useEffect(() => {
    if (!open || statsRef.current) return;
    let alive = true;
    apiRequest<MediaStats>("/api/media/stats")
      .then((stats) => {
        if (!alive) return;
        statsRef.current = stats;
        if (stats.max_file_bytes > 0) setMaxMB(Number((stats.max_file_bytes / (1024 * 1024)).toFixed(1)));
      })
      .catch(() => {
        /* 忽略 */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 关闭后清空暂存，下次打开从「未选择图片」开始。
  useEffect(() => {
    if (open) return;
    setSource(null);
    setPreview("");
    setZoom(1);
  }, [open]);

  // 取景框随缩放与图源重绘。
  useEffect(() => {
    if (!source) return;
    setPreview(renderCrop(source, zoom, PREVIEW_SIDE).toDataURL("image/jpeg", QUALITY));
  }, [source, zoom]);

  // ImageBitmap 不受 GC 管理，替换图源时手动释放上一张。
  useEffect(() => () => {
    if (source instanceof ImageBitmap) source.close();
  }, [source]);

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || processing) return;
    if (!IMAGE_TYPES.has(file.type)) {
      notify.error("请选择图片文件", "支持 PNG / JPEG / WebP");
      return;
    }
    const stats = statsRef.current;
    if (stats && stats.max_file_bytes > 0 && file.size > stats.max_file_bytes) {
      notify.error(`图片过大（上限 ${maxMB ?? Math.round(stats.max_file_bytes / 1024 / 1024)} MB）`);
      return;
    }
    setProcessing(true);
    try {
      const decoded = await decodeImage(file);
      setSource(decoded);
      setZoom(1);
    } catch {
      notify.error("图片解析失败", "请换一张图片重试");
    } finally {
      setProcessing(false);
    }
  }

  async function save() {
    if (!source || !action.acquire()) return;
    setPending("save");
    try {
      const blob = dataUrlToBlob(renderCrop(source, zoom, MAX_SIDE).toDataURL("image/jpeg", QUALITY));
      const form = new FormData();
      form.append("file", blob, "avatar.jpg");
      const data = await apiRequest<{ avatar_url: string }>("/api/media/avatar", { method: "POST", body: form });
      notify.success("头像已更新");
      onDone(data.avatar_url ?? "");
      onClose();
    } catch (error) {
      notify.error("上传失败", error instanceof Error ? error.message : undefined);
    } finally {
      setPending(null);
      action.release();
    }
  }

  async function remove() {
    if (!action.acquire()) return;
    setPending("remove");
    try {
      const data = await apiRequest<{ avatar_url: string }>("/api/media/avatar", { method: "DELETE" });
      notify.success("头像已移除");
      onDone(data.avatar_url ?? "");
      onClose();
    } catch (error) {
      notify.error("移除失败", error instanceof Error ? error.message : undefined);
    } finally {
      setPending(null);
      action.release();
    }
  }

  const custom = !!currentAvatar && currentAvatar.startsWith(CUSTOM_PREFIX);
  const hint = maxMB !== null ? `支持 PNG / JPEG / WebP，单张不超过 ${maxMB} MB` : "支持 PNG / JPEG / WebP";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent title="设置头像" className={styles.dialog} bodyClassName={styles.body}>
        <div className={styles.stage}>
          <span className={styles.preview}>
            {preview ? (
              <img src={preview} alt={`${userName} 的头像预览`} />
            ) : (
              <span className={styles.placeholder}>{processing ? "正在处理图片…" : "尚未选择图片"}</span>
            )}
          </span>
          <Slider
            className={styles.zoom}
            label="缩放（拖动调整取景范围）"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onValueChange={(value) => setZoom(value)}
            disabled={!source}
          />
        </div>

        <div className={styles.picker}>
          <input
            ref={fileRef}
            className={styles.file}
            type="file"
            accept={ACCEPT}
            onChange={(event) => void onPick(event)}
          />
          <Button variant="secondary" size="sm" loading={processing} disabled={action.busy} onClick={() => fileRef.current?.click()}>
            选择图片
          </Button>
          <span className={styles.hint} role="status">{processing ? "正在处理图片…" : hint}</span>
        </div>

        <div className={styles.actions}>
          {custom && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.remove}
              loading={pending === "remove"}
              disabled={action.busy}
              onClick={() => void remove()}
            >
              移除头像
            </Button>
          )}
          <span className={styles.spacer} />
          <Button variant="secondary" size="sm" disabled={action.busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={pending === "save"}
            disabled={!source || action.busy}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
