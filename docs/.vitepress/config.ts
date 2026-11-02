import { defineConfig } from "vitepress";

// zh and en on equal footing: every page exists in both directories.
export default defineConfig({
  title: "Swiftnest",
  description: "Turn your devices into capabilities any agent can call safely.",
  cleanUrls: true,
  locales: {
    root: { label: "Language", lang: "en" },
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/en/guide/quickstart" },
          { text: "Design", link: "/en/design" },
        ],
        sidebar: [
          {
            text: "Guide",
            items: [
              { text: "Quick start", link: "/en/guide/quickstart" },
              { text: "Two machines", link: "/en/guide/two-machines" },
              { text: "Devices", link: "/en/guide/devices" },
              { text: "Transfer files", link: "/en/guide/transfer-files" },
              { text: "Control this computer", link: "/en/guide/control-this-computer" },
              { text: "Live view and take-over", link: "/en/guide/live-view" },
              { text: "Concepts", link: "/en/guide/concepts" },
              { text: "Write your first plugin", link: "/en/guide/write-a-plugin" },
            ],
          },
          { text: "Design", items: [{ text: "Design document", link: "/en/design" }] },
        ],
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      themeConfig: {
        nav: [
          { text: "指南", link: "/zh/guide/quickstart" },
          { text: "设计", link: "/zh/design" },
        ],
        sidebar: [
          {
            text: "指南",
            items: [
              { text: "快速开始", link: "/zh/guide/quickstart" },
              { text: "两台机器", link: "/zh/guide/two-machines" },
              { text: "设备", link: "/zh/guide/devices" },
              { text: "传输文件", link: "/zh/guide/transfer-files" },
              { text: "控制这台电脑", link: "/zh/guide/control-this-computer" },
              { text: "实时画面与接管", link: "/zh/guide/live-view" },
              { text: "核心概念", link: "/zh/guide/concepts" },
              { text: "写第一个插件", link: "/zh/guide/write-a-plugin" },
            ],
          },
          { text: "设计", items: [{ text: "设计方案", link: "/zh/design" }] },
        ],
      },
    },
  },
});
