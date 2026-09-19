// 头像上传与裁剪（纯 Canvas，零新增依赖）
// ---------------------------------------------------------------------------
// 为什么在前端裁剪：
//   · 项目禁止新增依赖，服务端没有 sharp/jimp 这类图像库；
//   · 浏览器 Canvas 完全够用：裁成正方形 + 缩放到 512 以内 + 导出 JPEG，
//     一个 12MB 的手机原图能压到几十 KB，既省带宽也省用户存储配额；
//   · 顺带修正 EXIF 方向（手机竖拍的照片不加这一步会躺着）。
//
// 流程：选文件 → 读入内存 → 显示预览与缩放滑杆 → 确认后导出 → 交给父组件上传。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Slider, Button, Space, App as AntApp, Spin } from "antd";
import { API } from "../services/api";

const MAX_OUT = 512; // 输出边长上限（正方形）
const JPEG_QUALITY = 0.9;

/**
 * 把文件读成 ImageBitmap（带 EXIF 方向修正）。
 * createImageBitmap 的 imageOrientation:"from-image" 在 Chrome 81+ 支持；
 * 不支持时回退到 <img>（浏览器渲染时会自动应用 EXIF）。
 */
async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* 回退 */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片无法读取（可能已损坏）"));
    };
    img.src = url;
  });
}

/** 居中裁剪成正方形并缩放，返回 dataURL */
function renderSquare(src, zoom) {
  const w = src.width || src.naturalWidth || 0;
  const h = src.height || src.naturalHeight || 0;
  if (!w || !h) throw new Error("图片尺寸异常");
  const side = Math.min(w, h) / Math.max(1, zoom); // 缩放越大，取景越小（放大效果）
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  const out = Math.min(MAX_OUT, Math.round(side));
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  // 透明背景填白：JPEG 不支持透明，不填会变成黑块
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(src, sx, sy, side, side, 0, 0, out, out);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {function} props.onClose
 * @param {function} props.onDone 上传成功后回调（用于刷新用户信息）
 */
export default function AvatarUploader({ open, onClose, onDone }) {
  const { message } = AntApp.useApp();
  const fileRef = useRef(null);
  const imgRef = useRef(null);
  const [preview, setPreview] = useState("");
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // 关闭时清理，避免残留上一张图
  useEffect(() => {
    if (!open) {
      setPreview("");
      setZoom(1);
      imgRef.current = null;
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [open]);

  const pick = useCallback(
    async (file) => {
      if (!file) return;
      if (!/^image\//.test(file.type)) return message.error("请选择图片文件");
      if (file.size > 20 * 1024 * 1024) return message.error("图片过大（上限 20MB）");
      setLoading(true);
      try {
        const src = await loadImage(file);
        imgRef.current = src;
        setZoom(1);
        setPreview(renderSquare(src, 1));
      } catch (e) {
        message.error(e.message || "图片读取失败");
      } finally {
        setLoading(false);
      }
    },
    [message]
  );

  const applyZoom = (z) => {
    setZoom(z);
    if (!imgRef.current) return;
    try {
      setPreview(renderSquare(imgRef.current, z));
    } catch {
      /* 拖动过程中的瞬时失败忽略 */
    }
  };

  const upload = async () => {
    if (!preview) return message.info("请先选择图片");
    setBusy(true);
    try {
      const r = await API.post("/media/avatar", { dataUrl: preview });
      if (r?.success === false) throw new Error(r.message || "上传失败");
      message.success("头像已更新");
      onDone?.();
      onClose?.();
    } catch (e) {
      message.error(e.message || "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await API.del("/media/avatar");
      message.success("头像已移除");
      onDone?.();
      onClose?.();
    } catch (e) {
      message.error(e.message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="设置头像"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={remove} loading={busy} danger>
            移除头像
          </Button>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={upload} loading={busy} disabled={!preview}>
            保存
          </Button>
        </Space>
      }
      width={420}
    >
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        {/* 预览区固定成圆形，所见即所得（最终就是圆形头像） */}
        <div
          style={{
            width: 160,
            height: 160,
            margin: "0 auto 12px",
            borderRadius: "50%",
            overflow: "hidden",
            background: "var(--inset)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--line)",
          }}
        >
          {loading ? (
            <Spin />
          ) : preview ? (
            <img src={preview} alt="头像预览" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>未选择图片</span>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          style={{ display: "none" }}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Button onClick={() => fileRef.current?.click()} block>
            选择图片
          </Button>
          {preview ? (
            <>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>缩放（拖动调整取景范围）</div>
              <Slider min={1} max={3} step={0.05} value={zoom} onChange={applyZoom} />
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              支持 PNG / JPEG / GIF / WebP，会自动裁成正方形并压缩
            </div>
          )}
        </Space>
      </div>
    </Modal>
  );
}
