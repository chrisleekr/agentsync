import type { SecretPolicy } from "../core/sanitizer";
import { scanForSecrets } from "../core/sanitizer";
import type { SnapshotResult } from "./_utils";
import { isFatalSnapshotWarning } from "./skills-walker";

const VAULT_WARNING_MARKER = "[vault:";

function vaultWarningMarker(vaultPath: string): string {
  return `${VAULT_WARNING_MARKER}${encodeURIComponent(vaultPath)}]`;
}

/** Attach an exact vault identity to a fatal warning emitted before an artifact exists. */
export function annotateSnapshotWarning(warning: string, vaultPath: string): string {
  return `${warning} ${vaultWarningMarker(vaultPath)}`;
}

export function walkerWarningMatchesSelection(
  warning: string,
  pathFilter: ReadonlySet<string>,
  agentName: string,
): boolean {
  if (warning.includes(VAULT_WARNING_MARKER)) {
    for (const vaultPath of pathFilter) {
      if (warning.includes(vaultWarningMarker(vaultPath))) return true;
    }
    return false;
  }
  for (const vaultPath of pathFilter) {
    if (!vaultPath.endsWith(".tar.age") || !vaultPath.startsWith(`${agentName}/`)) continue;
    const skillDir = vaultPath.slice(0, -".tar.age".length);
    if (warning.includes(`${skillDir}/`)) return true;
  }
  return false;
}

/** Apply the security checks shared by push and status to snapshot plaintext. */
export function snapshotSafetyIssues(
  agentName: string,
  snapshot: SnapshotResult,
  policy: SecretPolicy,
  pathFilter?: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  for (const artifact of snapshot.artifacts) {
    for (const warning of artifact.warnings) {
      if (warning.startsWith("Detected literal secret")) issues.push(`[${agentName}] ${warning}`);
    }
    if (artifact.vaultPath.endsWith(".tar.age")) continue;
    for (const warning of scanForSecrets(artifact.plaintext, artifact.sourcePath, policy)) {
      issues.push(`[${agentName}] ${warning}`);
    }
  }
  for (const warning of snapshot.warnings) {
    if (!isFatalSnapshotWarning(warning)) continue;
    if (pathFilter && !walkerWarningMatchesSelection(warning, pathFilter, agentName)) continue;
    issues.push(`[${agentName}] ${warning}`);
  }
  return issues;
}
