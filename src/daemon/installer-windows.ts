/**
 * Windows Task Scheduler installer for the AgentSync daemon.
 *
 * Creates a scheduled task that runs at logon:
 *   Task name: AgentSync
 *
 * Requires PowerShell and schtasks.exe (available on all modern Windows).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "@clack/prompts";

const execFileAsync = promisify(execFile);

const TASK_NAME = "AgentSync";

/** Build the Task Scheduler XML definition for the current executable. */
function buildXml(executablePath: string): string {
  const escapedPath = executablePath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AgentSync daemon - encrypts and syncs AI agent configs</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedPath}</Command>
      <Arguments>daemon _run</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Install and start the Windows scheduled task that runs the daemon at logon. */
export async function installWindows(executablePath: string): Promise<void> {
  const xml = buildXml(executablePath);
  const tmpXml = `${process.env.TEMP ?? "C:\\Temp"}\\agentsync-task.xml`;

  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(tmpXml, xml, "utf16le");

  try {
    await execFileAsync("schtasks", [
      "/Create",
      "/TN",
      TASK_NAME,
      "/XML",
      tmpXml,
      "/F", // overwrite if exists
    ]);
  } finally {
    await rm(tmpXml, { force: true });
  }

  log.success(`Installed Windows scheduled task: ${TASK_NAME}`);

  // Start immediately
  await execFileAsync("schtasks", ["/Run", "/TN", TASK_NAME]);
}

/** Stop and delete the Windows scheduled task if it exists. */
export async function uninstallWindows(): Promise<void> {
  try {
    await execFileAsync("schtasks", ["/End", "/TN", TASK_NAME]);
  } catch {
    // Not running — ignore
  }

  await execFileAsync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
  log.success(`Removed Windows scheduled task: ${TASK_NAME}`);
}

/** Start the installed Windows scheduled task immediately. */
export async function startWindows(): Promise<void> {
  await execFileAsync("schtasks", ["/Run", "/TN", TASK_NAME]);
}

/** Stop the running Windows scheduled task instance. */
export async function stopWindows(): Promise<void> {
  await execFileAsync("schtasks", ["/End", "/TN", TASK_NAME]);
}

/** Check whether the Windows scheduled task already exists. */
export async function isInstalledWindows(): Promise<boolean> {
  try {
    await execFileAsync("schtasks", ["/Query", "/TN", TASK_NAME]);
    return true;
  } catch {
    return false;
  }
}
