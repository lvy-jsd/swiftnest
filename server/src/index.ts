export {
  loadConfig,
  defaultHome,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_PERSONA,
  type ServerConfig,
  type ModelConfig,
} from './config.js';
export { writeProfile, modelPatch, profileDir, dshHome, PROFILE_NAME, BUNDLES, PROVIDER_ID } from './profile.js';
export {
  startKernel,
  parseReadyLine,
  resolveKernel,
  resolveAppDist,
  type RunningKernel,
  type StartOptions,
} from './kernel.js';
export { pairingUrl, webAppUrl } from './pairing.js';

export {
  PLUGIN_MANIFEST,
  checkManifest,
  type Plugin,
  type PluginManifest,
  type NpmGroupSource,
  type NpmSource,
} from './plugins.js';
export { installPlugins, verifyIntegrity } from './plugin-install.js';
export { profilePlugins, isInstalled } from './profile-plugins.js';
export {
  installToolUltra,
  toolUltraDir,
  toolUltraPatch,
  isBuilt,
  TOOL_ULTRA_SOURCE,
  TOOL_ULTRA_PACKAGES,
  TOOL_ULTRA_ID,
} from './tool-ultra.js';
