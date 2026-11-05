import { defineConfig } from 'vitepress';

// Chinese is the default; English pages have matching Chinese counterparts.
export default defineConfig({
  title: 'Swiftnest',
  description: '把你的设备变成智能体能安全调用的能力。',
  cleanUrls: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/quickstart' },
          { text: 'English', link: '/en/' },
        ],
        outlineTitle: '本页内容',
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        darkModeSwitchTitle: '切换为深色模式',
        lightModeSwitchTitle: '切换为浅色模式',
        langMenuLabel: '语言',
        notFound: {
          title: '页面不存在',
          quote: '这个页面可能已移动，请从首页继续。',
          linkText: '返回首页',
          linkLabel: '返回首页',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/quickstart' },
          { text: 'Design', link: '/en/design' },
        ],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Quick start', link: '/en/guide/quickstart' },
              { text: 'Access away from home', link: '/en/guide/relay' },
              { text: 'Two machines', link: '/en/guide/two-machines' },
              { text: 'Devices', link: '/en/guide/devices' },
              { text: 'Plugins', link: '/en/guide/plugins' },
              { text: 'Tool Ultra', link: '/en/guide/tool-ultra' },
              { text: 'Memory', link: '/en/guide/memory' },
              { text: 'Search past chats', link: '/en/guide/chat-search' },
              { text: 'Transfer files', link: '/en/guide/transfer-files' },
              { text: 'Control this computer', link: '/en/guide/control-this-computer' },
              { text: 'Use this phone', link: '/en/guide/use-this-phone' },
              { text: 'Live view and take-over', link: '/en/guide/live-view' },
              { text: 'Concepts', link: '/en/guide/concepts' },
              { text: 'Write your first plugin', link: '/en/guide/write-a-plugin' },
            ],
          },
          { text: 'Design', items: [{ text: 'Design document', link: '/en/design' }] },
        ],
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      themeConfig: {
        outlineTitle: '本页内容',
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '外观',
        darkModeSwitchTitle: '切换为深色模式',
        lightModeSwitchTitle: '切换为浅色模式',
        langMenuLabel: '语言',
        notFound: {
          title: '页面不存在',
          quote: '这个页面可能已移动，请从首页继续。',
          linkText: '返回首页',
          linkLabel: '返回首页',
        },
        nav: [
          { text: '指南', link: '/zh/guide/quickstart' },
          { text: '设计', link: '/zh/design' },
        ],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '快速开始', link: '/zh/guide/quickstart' },
              { text: '在外访问', link: '/zh/guide/relay' },
              { text: '两台机器', link: '/zh/guide/two-machines' },
              { text: '设备', link: '/zh/guide/devices' },
              { text: '插件', link: '/zh/guide/plugins' },
              { text: 'Tool Ultra', link: '/zh/guide/tool-ultra' },
              { text: '记忆', link: '/zh/guide/memory' },
              { text: '搜索历史对话', link: '/zh/guide/chat-search' },
              { text: '传输文件', link: '/zh/guide/transfer-files' },
              { text: '控制这台电脑', link: '/zh/guide/control-this-computer' },
              { text: '使用这台手机', link: '/zh/guide/use-this-phone' },
              { text: '实时画面与接管', link: '/zh/guide/live-view' },
              { text: '核心概念', link: '/zh/guide/concepts' },
              { text: '写第一个插件', link: '/zh/guide/write-a-plugin' },
            ],
          },
          { text: '设计', items: [{ text: '设计方案', link: '/zh/design' }] },
        ],
      },
    },
  },
});
