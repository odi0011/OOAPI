import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { ThemeProvider } from "./theme/ThemeContext";
import { AppProvider } from "./context/AppContext";
import App from "./App";
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

// Inter 字体（beautifului 使用 Inter；国内网络优先走系统字体回退）
try {
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = "https://rsms.me/";
  document.head.appendChild(link);

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://rsms.me/inter/inter.css";
  document.head.appendChild(css);
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
