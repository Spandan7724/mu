import { isReleaseTarget, prepareRipgrepPackage, RELEASE_SPECS } from "./package-release.ts";

const target = process.argv[2];
const packageDir = process.argv[3];

if (!isReleaseTarget(target) || !packageDir) {
  console.error(
    `usage: prepare-ripgrep-package.ts <${Object.keys(RELEASE_SPECS).join("|")}> <package-dir>`,
  );
  process.exitCode = 1;
} else {
  try {
    await prepareRipgrepPackage(RELEASE_SPECS[target], packageDir);
    console.log(`prepared ripgrep ${RELEASE_SPECS[target].ripgrep.version} in ${packageDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
