import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { ThemeProvider } from "./theme/ThemeContext";
import { AppProvider } from "./context/AppContext";
import App from "./App";
// 正文字体：Noto Sans SC（本地打包，避免依赖外网字体 CDN）
// 按语种导入（chinese-simplified + latin），避免引入上百个未用子集
import "@fontsource/noto-sans-sc/chinese-simplified-400.css";
import "@fontsource/noto-sans-sc/latin-400.css";
import "@fontsource/noto-sans-sc/chinese-simplified-500.css";
import "@fontsource/noto-sans-sc/latin-500.css";
import "@fontsource/noto-sans-sc/chinese-simplified-700.css";
import "@fontsource/noto-sans-sc/latin-700.css";
import "./styles.css";

// antd 的日期组件（rc-picker）直接用 dayjs 取星期/周首日，不注册中文 locale
// 会显示英文缩写且周首日为周日
dayjs.locale("zh-cn");

// 启动前先应用持久化主题，避免首帧闪烁
try {
  const mode = localStorage.getItem("ooapi-theme") || "system";
  const dark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntApp>
        <BrowserRouter>
          <AppProvider>
            <App />
          </AppProvider>
        </BrowserRouter>
      </AntApp>
    </ThemeProvider>
  </React.StrictMode>
);
