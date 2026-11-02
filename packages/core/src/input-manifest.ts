// Checked against the native manifest by the parity test.
export const inputManifest = {
  "id": "input",
  "version": "0.0.1",
  "title": {
    "en": "Input",
    "zh": "\u8f93\u5165"
  },
  "permissions": [
    "input.inject"
  ],
  "tools": [
    {
      "name": "input_click",
      "description": "Click a screenshot point. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "captureId": {
            "type": "string",
            "description": "Capture id returned by screen_capture"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "button": {
            "type": "string",
            "enum": [
              "left",
              "right"
            ]
          }
        },
        "required": [
          "displayId",
          "captureId",
          "x",
          "y"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "input_move",
      "description": "Move to a screenshot point. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "captureId": {
            "type": "string",
            "description": "Capture id returned by screen_capture"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          }
        },
        "required": [
          "displayId",
          "captureId",
          "x",
          "y"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "input_drag",
      "description": "Drag between two screenshot points. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "captureId": {
            "type": "string",
            "description": "Capture id returned by screen_capture"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "toX": {
            "type": "number"
          },
          "toY": {
            "type": "number"
          }
        },
        "required": [
          "displayId",
          "captureId",
          "x",
          "y",
          "toX",
          "toY"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "input_scroll",
      "description": "Scroll in pixels. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "dx": {
            "type": "number"
          },
          "dy": {
            "type": "number"
          }
        },
        "required": [
          "displayId",
          "dx",
          "dy"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "input_type",
      "description": "Type literal text. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "text": {
            "type": "string",
            "maxLength": 16384
          }
        },
        "required": [
          "displayId",
          "text"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "input_key",
      "description": "Press a key or combo such as ctrl+c. Refused while the owner has control.",
      "risk": "exec",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string",
            "description": "Display id returned by screen_info"
          },
          "key": {
            "type": "string",
            "maxLength": 128
          }
        },
        "required": [
          "displayId",
          "key"
        ],
        "additionalProperties": false
      }
    }
  ]
} as const;
