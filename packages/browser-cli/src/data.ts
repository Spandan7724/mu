// The browser product's data namespace, re-exported from the profile so the
// product and the profile can never disagree about where private state lives.
export {
  browserArtifactsDir,
  browserConfigPath,
  browserDataDir,
  browserDataLayout,
  browserLogsDir,
  browserModelCatalogPath,
  browserProfilesDir,
  browserSessionsDir,
  ensureBrowserDataRoot,
} from "@mu/profile-browser/profile";
