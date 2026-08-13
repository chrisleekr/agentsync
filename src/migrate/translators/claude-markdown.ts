const CLAUDE_FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/;
const CLAUDE_MULTILINE_SHELL_INTERPOLATIONS = /```!\s*\n?([\s\S]*?)\n?```/g;

interface Fence {
  marker: "`" | "~";
  length: number;
}

function openingFence(line: string): (Fence & { info: string }) | null {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const delimiter = match[1] as string;
  return {
    marker: delimiter[0] as Fence["marker"],
    length: delimiter.length,
    info: match[2] ?? "",
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(
    match && match[1]?.[0] === fence.marker && (match[1]?.length ?? 0) >= fence.length,
  );
}

function textOutsideInlineCode(line: string, matches: (text: string) => boolean): boolean {
  let segmentStart = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let markerLength = 1;
    while (line[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const close = line.indexOf(marker, index + markerLength);
    if (close < 0) {
      index += markerLength;
      continue;
    }
    if (matches(line.slice(segmentStart, index))) return true;
    index = close + markerLength;
    segmentStart = index;
  }
  return matches(line.slice(segmentStart));
}

function hasInlineShellInterpolation(line: string): boolean {
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let markerLength = 1;
      while (line[index + markerLength] === "`") markerLength += 1;
      const marker = "`".repeat(markerLength);
      const close = line.indexOf(marker, index + markerLength);
      index = close < 0 ? index + markerLength : close + markerLength;
      continue;
    }
    if (
      line[index] === "!" &&
      (index === 0 || /\s/.test(line[index - 1] ?? "")) &&
      line[index + 1] === "`"
    ) {
      const close = line.indexOf("`", index + 2);
      if (close > index + 2) return true;
    }
    index += 1;
  }
  return false;
}

export function hasClaudeFileImport(markdown: string): boolean {
  let fence: Fence | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = openingFence(line);
    if (opening) {
      fence = opening;
      continue;
    }
    if (textOutsideInlineCode(line, (text) => CLAUDE_FILE_REFERENCE.test(text))) return true;
  }
  return false;
}

export function hasClaudeSkillShellInterpolation(markdown: string): boolean {
  if (hasClaudeMultilineShellInterpolation(markdown)) return true;
  for (const line of markdown.split(/\r?\n/)) {
    if (hasInlineShellInterpolation(line)) return true;
  }
  return false;
}

export function hasClaudeMultilineShellInterpolation(markdown: string): boolean {
  for (const match of markdown.matchAll(CLAUDE_MULTILINE_SHELL_INTERPOLATIONS)) {
    if (match[1]?.trim()) return true;
  }
  return false;
}
