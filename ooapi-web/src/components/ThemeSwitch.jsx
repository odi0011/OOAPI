import React from "react";
import { Segmented, Tooltip } from "antd";
import { SunOutlined, MoonOutlined, DesktopOutlined } from "@ant-design/icons";
import { useTheme } from "../theme/ThemeContext";

// 主题切换：明亮 / 黑暗 / 跟随系统
export default function ThemeSwitch({ size = "middle" }) {
  const { mode, setMode } = useTheme();
  return (
    <Segmented
      size={size}
      value={mode}
      onChange={setMode}
      options={[
        {
          value: "light",
          icon: (
            <Tooltip title="明亮">
              <SunOutlined />
            </Tooltip>
          ),
        },
        {
          value: "dark",
          icon: (
            <Tooltip title="黑暗">
              <MoonOutlined />
            </Tooltip>
          ),
        },
        {
          value: "system",
          icon: (
            <Tooltip title="跟随系统">
              <DesktopOutlined />
            </Tooltip>
          ),
        },
      ]}
    />
  );
}
