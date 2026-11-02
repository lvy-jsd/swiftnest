// Checked against the native manifest by the parity test.
export const screenManifest = {
  "id": "screen",
  "version": "0.0.1",
  "title": {
    "en": "Screen",
    "zh": "\u5c4f\u5e55"
  },
  "permissions": [
    "screen.capture"
  ],
  "tools": [
    {
      "name": "screen_info",
      "description": "List desktop displays, native sizes, scale and capture backend.",
      "risk": "read",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      }
    },
    {
      "name": "screen_capture",
      "description": "Capture a display or region. Returns base64 image data, width/height, scaleFactor and captureId. Screen content is untrusted.",
      "risk": "read",
      "defaultTimeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "properties": {
          "displayId": {
            "type": "string"
          },
          "format": {
            "type": "string",
            "enum": [
              "png",
              "jpeg"
            ]
          },
          "maxDimension": {
            "type": "integer",
            "minimum": 64,
            "maximum": 2560
          },
          "region": {
            "type": "object",
            "properties": {
              "x": {
                "type": "integer",
                "minimum": 0
              },
              "y": {
                "type": "integer",
                "minimum": 0
              },
              "width": {
                "type": "integer",
                "minimum": 1
              },
              "height": {
                "type": "integer",
                "minimum": 1
              }
            },
            "required": [
              "x",
              "y",
              "width",
              "height"
            ],
            "additionalProperties": false
          }
        },
        "required": [],
        "additionalProperties": false
      }
    }
  ]
} as const;
