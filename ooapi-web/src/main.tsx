import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/* 全站字体：公开可商用的中文字体，随包分发。
   国内访问 Google Fonts 不稳定，因此不引外链。

   只用 400 字重：这些中文字体本身笔画偏粗，再加粗会糊成一团。
   站内字重上限统一到 500（见 styles/global.css 的说明）。 */
import "@fontsource/zcool-kuaile/400.css";
import "@fontsource/zcool-qingke-huangyou/400.css";
import "@fontsource/zcool-xiaowei/400.css";
import "@fontsource/ma-shan-zheng/400.css";
import "@fontsource/long-cang/400.css";
import "@fontsource/zhi-mang-xing/400.css";
import "@fontsource/liu-jian-mao-cao/400.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-serif-sc/400.css";

/* 像素体（ZPix，MIT）放在 public/fonts，用 @font-face 声明 */
import "./styles/zpix.css";

// Arc UI 的组件库样式全局可用 —— 登录、注册、后台等页面直接用它原本的外观。
import "@/components/arc/foundation.css";

// 只做复位与字体基线，不含任何视觉风格。
import "@/styles/global.css";

import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
