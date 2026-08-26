export function formatWorkspacePath(workspace: string, maxColumns: number): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  let value = workspace;
  if (home.length > 0 && workspace.toLowerCase().startsWith(home.toLowerCase())) {
    value = `~${workspace.slice(home.length)}`;
  }
  if (value.length <= maxColumns) return value;
  const tail = value.slice(-(maxColumns - 1));
  const cut = tail.indexOf("\\") === -1 ? tail.indexOf("/") : Math.max(tail.indexOf("\\"), tail.indexOf("/"));
  return `...${cut === -1 ? tail : tail.slice(cut)}`;
}
