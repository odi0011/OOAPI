const fs = require("fs");
const path = require("path");

/*
  组件库英文字面量中文化。

  为什么直接改组件源码而不是在外面传参：
  registry 模式下这些组件已归项目所有（不是 node_modules 里的黑盒），
  改源码是本项目的既定做法（见 ai协作.md 2.3）。而且很多文案是
  aria-label 与内部默认值，外层传参覆盖不到。

  只处理本项目实际用到的组件 —— 未使用的组件改它没有收益，
  反而增加 diff 与出错面。
*/

// 实际用到的组件目录
const USED = [
  "badge", "button", "card", "checkbox", "dialog", "dropdown-menu",
  "empty-state", "file-dropzone", "input", "line-chart", "donut-chart",
  "bar-chart", "sparkline", "gauge", "metric-card", "notification-center",
  "number-field", "otp-input", "password-field", "progress", "radio-group",
  "search-field", "segmented-control", "select", "sortable-data-table",
  "switch", "tabs", "textarea", "theme-switch", "tooltip", "treemap",
  "waffle-chart", "streamgraph", "ridgeline", "activity-heatmap",
  "command-palette", "expanding-search", "avatar", "timeline", "pagination",
  "filter-toolbar", "usage-meter", "card-stack", "animated-counter",
  "brush-chart", "user-menu", "breadcrumb", "accordion", "popover",
];

// 需要替换的文案。键是英文原文，值是中文。
// 顺序无关，脚本会做全量字面量替换。
const MAP = {
  // 通用
  "Select an option": "请选择",
  "No data yet": "暂无数据",
  "No data": "暂无数据",
  "No data for this range": "该范围暂无数据",
  "Loading": "加载中",
  "Loading…": "加载中…",
  "Clear": "清除",
  "Clear search": "清除搜索",
  "Search": "搜索",
  "Search commands": "搜索命令",
  "Command palette": "命令面板",
  "Command results": "搜索结果",
  "Close": "关闭",
  "Close dialog": "关闭对话框",
  "Close notifications": "关闭通知",
  "Close quick look": "关闭快速查看",
  "Close command palette": "关闭命令面板",
  "Close menu": "关闭菜单",
  "Notifications": "通知",
  "Show notifications": "查看通知",
  "Add files": "添加文件",
  "Add file": "添加文件",
  "Files": "文件",
  "Drop to upload": "松开即可上传",
  "Drop files here or choose from your device": "把文件拖到这里，或点击选择",
  "Drop to add files": "松开已添加文件",
  "Drop to add the file": "松开已添加文件",
  "Choose from your device": "从设备选择",
  "Retry": "重试",
  "Remove": "移除",
  "Uploaded": "已上传",
  "Uploading": "上传中",
  "Failed": "失败",
  "Cancel": "取消",
  "Confirm": "确定",
  "Save": "保存",
  "Delete": "删除",
  "Edit": "编辑",
  "Copy": "复制",
  "Copied": "已复制",
  "Copy code to clipboard": "复制代码",
  "Previous": "上一页",
  "Next": "下一页",
  "Page": "页",
  "Sort ascending": "升序排列",
  "Sort descending": "降序排列",
  "Show password": "显示密码",
  "Hide password": "隐藏密码",
  "Checkbox": "复选框",
  "Increase": "增加",
  "Decrease": "减少",
  "Active filters": "已选筛选",
  "Add filter": "添加筛选",
  "Back to fields": "返回字段列表",
  "Reset": "重置",
  "Reset view": "重置视图",
  "Show all": "显示全部",
  "Show less": "收起",
  "Show more": "展开",
  "More": "更多",
  "Less": "更少",
  "Highlight days by level": "按活跃程度高亮",
  "Window start": "窗口起点",
  "Window end": "窗口终点",
  "Filter": "筛选",
  "Filters": "筛选",
  "Apply": "应用",
  "Default": "默认",
  "Light": "浅色",
  "Dark": "深色",
  "System": "跟随系统",
  "Switch to light mode": "切换到浅色",
  "Switch to dark mode": "切换到深色",
  "Toggle theme": "切换主题",
  "Notifications list": "通知列表",
  "Mark all as read": "全部标为已读",
  "Mark as read": "标为已读",
  "Dismiss": "忽略",
  "No notifications": "暂无通知",
  "You are all caught up": "没有新通知了",
  "View all": "查看全部",
  "Settings": "设置",
  "Sign out": "退出登录",
  "Sign in": "登录",
  "Sign up": "注册",
  "Profile": "个人资料",
  "Account": "账号",
  "Preferences": "偏好设置",
  "Available": "在线",
  "Busy": "忙碌",
  "Away": "离开",
  "Reset to first": "回到开头",
  "Go to first page": "第一页",
  "Go to last page": "最后一页",
  "Previous page": "上一页",
  "Next page": "下一页",
  "of": "共",
  "items": "项",
};

let totalReplacements = 0;
const touchedFiles = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) process(p);
  }
}

function process(file) {
  let src = fs.readFileSync(file, "utf8");
  const before = src;

  for (const [en, zh] of Object.entries(MAP)) {
    /*
      只替换「引号里的完整字面量」，不碰字符串的其他出现位置。

      为什么不用全局替换：像 "Save" 这种词可能出现在变量名、
      localStorage 键或 aria 属性里，全部替换会改坏逻辑。
      限定在引号内、且后面紧跟引号或结束符，才安全。
    */
    const patterns = [
      new RegExp(`"${escapeRe(en)}"`, "g"),
      new RegExp(`'${escapeRe(en)}'`, "g"),
    ];
    for (const re of patterns) {
      const matches = src.match(re);
      if (matches) {
        totalReplacements += matches.length;
        src = src.replace(re, `"${zh}"`);
      }
    }
  }

  if (src !== before) {
    fs.writeFileSync(file, src);
    touchedFiles.push(file.replace(/^src\/components\/arc\//, ""));
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const comp of USED) {
  const dir = path.join("src/components/arc", comp);
  if (fs.existsSync(dir)) {
    const stat = fs.statSync(dir);
    if (stat.isDirectory()) walk(dir);
    else process(dir);
  }
}

console.log("替换 " + totalReplacements + " 处，涉及 " + touchedFiles.length + " 个文件：\n");
for (const f of touchedFiles.sort()) console.log("  " + f);
