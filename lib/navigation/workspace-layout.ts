/** Visual composition only. Never used for authorization or data selection. */
export function workspaceLayout(
  path: string,
): "conversation" | "board" | "preferences" | "insights" | "directory" | "studio" | "agenda" {
  if (path === "/app" || path.startsWith("/app/inbox")) return "conversation";
  if (/^\/app\/(kanban|pipelines|leads)(\/|$)/.test(path)) return "board";
  if (/^\/app\/(settings|ai\/(credentials|providers)|webhooks)(\/|$)/.test(path))
    return "preferences";
  if (/^\/app\/(metrics|activities|audit|ads|ai\/(usage|runs|evolution))(\/|$)/.test(path))
    return "insights";
  if (/^\/app\/(agenda|tasks)(\/|$)/.test(path)) return "agenda";
  if (/^\/app\/(ai\/agents\/|connections|prospecting)/.test(path)) return "studio";
  return "directory";
}
