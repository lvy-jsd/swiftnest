/**
 * @swiftnest/sdk — everything a plugin author needs: the plugin contract, error type, protocol types,
 * and `createTestNest` to exercise a plugin against a simulated Nest and devices, no hardware required.
 */
export {
  definePlugin,
  SwiftnestFailure,
  type Capability,
  type InvokeContext,
  type PluginContext,
  type PerchPluginContext,
  type NestPluginContext,
  type SwiftnestPlugin,
  type ToolOutput,
} from "@swiftnest/core";
export type {
  CapabilityManifestInput,
  LocalizedText,
  Risk,
  TaskSnapshot,
  ToolDescriptorInput,
  ToolResult,
} from "@swiftnest/protocol";
export { createTestNest, type TestNest, type TestDevice } from "./testing.js";
