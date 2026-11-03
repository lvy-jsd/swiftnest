// Checked against the native manifest by the parity test.
export const inputManifest = {
  id: 'input',
  version: '0.0.1',
  title: {
    en: 'Input',
    zh: '输入',
  },
  permissions: ['input.inject'],
  tools: [
    {
      name: 'input_click',
      description: {
        en: 'Click a screenshot point. Refused while the owner has control.',
        zh: '点击截图中的坐标，所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          captureId: {
            type: 'string',
            description: 'Capture id returned by screen_capture',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
          button: {
            type: 'string',
            enum: ['left', 'right'],
          },
        },
        required: ['displayId', 'captureId', 'x', 'y'],
        additionalProperties: false,
      },
    },
    {
      name: 'input_move',
      description: {
        en: 'Move to a screenshot point. Refused while the owner has control.',
        zh: '将指针移至截图坐标，所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          captureId: {
            type: 'string',
            description: 'Capture id returned by screen_capture',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
        },
        required: ['displayId', 'captureId', 'x', 'y'],
        additionalProperties: false,
      },
    },
    {
      name: 'input_drag',
      description: {
        en: 'Drag between two screenshot points. Refused while the owner has control.',
        zh: '在截图中的两点之间拖动，所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          captureId: {
            type: 'string',
            description: 'Capture id returned by screen_capture',
          },
          x: {
            type: 'number',
          },
          y: {
            type: 'number',
          },
          toX: {
            type: 'number',
          },
          toY: {
            type: 'number',
          },
        },
        required: ['displayId', 'captureId', 'x', 'y', 'toX', 'toY'],
        additionalProperties: false,
      },
    },
    {
      name: 'input_scroll',
      description: {
        en: 'Scroll in pixels. Refused while the owner has control.',
        zh: '按像素滚动，所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          dx: {
            type: 'number',
          },
          dy: {
            type: 'number',
          },
        },
        required: ['displayId', 'dx', 'dy'],
        additionalProperties: false,
      },
    },
    {
      name: 'input_type',
      description: {
        en: 'Type literal text. Refused while the owner has control.',
        zh: '输入文本，所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          text: {
            type: 'string',
            maxLength: 16384,
          },
        },
        required: ['displayId', 'text'],
        additionalProperties: false,
      },
    },
    {
      name: 'input_key',
      description: {
        en: 'Press a key or combo such as ctrl+c. Refused while the owner has control.',
        zh: '按下按键或组合键（例如 ctrl+c），所有者接管时拒绝执行。',
      },
      risk: 'exec',
      defaultTimeoutMs: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          displayId: {
            type: 'string',
            description: 'Display id returned by screen_info',
          },
          key: {
            type: 'string',
            maxLength: 128,
          },
        },
        required: ['displayId', 'key'],
        additionalProperties: false,
      },
    },
  ],
} as const;
