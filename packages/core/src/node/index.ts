export {
  candidatePaths,
  existingConfigs,
  type ConfigLocation,
  type DiscoveryContext,
} from "./discover.js";
export {
  doctor,
  type DoctorOptions,
  type DoctorReport,
  type FileReport,
  type ServerReport,
} from "./doctor.js";
export { handshake, type HandshakeOptions, type HandshakeReport } from "./handshake.js";
export {
  detectVersionManagers,
  nodeProbe,
  readTextFile,
  which,
  type RuntimeOptions,
} from "./runtime.js";
