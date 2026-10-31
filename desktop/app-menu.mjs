/**
 * The application menu as a plain template (no Electron import), so it can be tested.
 * desktop/main.mjs builds it with Menu.buildFromTemplate.
 */

export const HELP_LINKS = Object.freeze({
  guide: "https://github.com/zifeixu85/skill-control#readme",
  issues: "https://github.com/zifeixu85/skill-control/issues",
});

/**
 * @param {{ platform: string, appName: string, developmentMode: boolean,
 *   openSettings: () => void, openExternal: (url: string) => void }} options
 */
export function buildMenuTemplate({ platform, appName, developmentMode, openSettings, openExternal }) {
  const mac = platform === "darwin";
  const settings = { label: "设置…", accelerator: "CommandOrControl+,", click: () => openSettings() };
  return [
    ...(mac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about", label: `关于 ${appName}` },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "hide", label: "隐藏" },
              { role: "hideOthers", label: "隐藏其他应用" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: `退出 ${appName}` },
            ],
          },
        ]
      : [
          {
            label: "文件",
            submenu: [settings, { type: "separator" }, { role: "quit", label: "退出" }],
          },
        ]),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新载入" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        // ⌘= (no Shift) zooms in too, as in browsers.
        { role: "zoomIn", label: "放大", accelerator: "CommandOrControl+=", visible: false, acceleratorWorksWhenHidden: true },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
        ...(developmentMode ? [{ type: "separator" }, { role: "toggleDevTools", label: "开发者工具" }] : []),
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "close", label: "关闭窗口" },
        ...(mac ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }] : []),
      ],
    },
    {
      label: "帮助",
      role: "help",
      submenu: [
        { label: "使用说明", click: () => openExternal(HELP_LINKS.guide) },
        { label: "反馈问题", click: () => openExternal(HELP_LINKS.issues) },
      ],
    },
  ];
}
