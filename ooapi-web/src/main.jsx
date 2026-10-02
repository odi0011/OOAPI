import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { ThemeProvider } from "./theme/ThemeContext";
import { bootAppearance } from "./theme/presets";
import { AppProvider } from "./context/AppContext";
import App from "./App";
// 站酷快乐体从 public/fonts 本地加载，首次打开也不依赖字体 CDN。
import "./styles.css";

// antd 的日期组件（rc-picker）直接用 dayjs 取星期/周首日，不注册中文 locale
// 会显示英文缩写且周首日为周日
dayjs.locale("zh-cn");

// 背景底纹层：必须在 React 挂载前就存在于 DOM 里，
// 否则 applyAppearance 找不到节点会让底纹静默失效（设置里选了却没效果）。
{
  const layer = document.createElement("div");
  layer.id = "app-bg";
  layer.setAttribute("aria-hidden", "true");
  document.body.insertBefore(layer, document.body.firstChild);
}

// 启动前应用外观（站点设置的上次缓存），避免先按写死的默认渲染再跳变。
// 挂载后由 ThemeProvider 接管（它会按最新 /api/status 再算一次）。
try {
  bootAppearance();
} catch {
  /* 首帧外观失败不影响使用 */
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
