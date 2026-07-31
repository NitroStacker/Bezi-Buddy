import type { BeziSession } from "./bezi-session";

type WorkspaceSelection = {
  id: string;
  label: string;
};

export function explicitThreadSelection(
  session: BeziSession,
  workspaceLabel: string | null,
) {
  return {
    type: "bezi.thread.activate" as const,
    body: compact({
      sessionId: session.id,
      threadId: session.threadId,
      title: session.title,
      workspaceId: session.workspaceId,
      workspaceLabel: workspaceLabel ?? undefined,
    }),
  };
}

export function explicitWorkspaceSelection(workspace: WorkspaceSelection) {
  return {
    type: "bezi.workspace.activate" as const,
    body: {
      workspaceId: workspace.id,
      label: workspace.label,
    },
  };
}

function compact<T extends Record<string, string | undefined>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}
