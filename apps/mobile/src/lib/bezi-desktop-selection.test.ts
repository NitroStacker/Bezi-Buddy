import { describe, expect, it } from "vitest";
import {
  explicitThreadSelection,
  explicitWorkspaceSelection,
} from "./bezi-desktop-selection";

describe("explicit Bezi desktop selection", () => {
  it("targets the tapped thread and its workspace", () => {
    expect(
      explicitThreadSelection(
        {
          id: "4563e0cc-5d22-4f4a-80a4-3fd5b7308760",
          threadId: "c018a98b-2ffc-42a2-9027-1dc2575052cf",
          title: "Fix page syncing",
          workspaceId: "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f",
        },
        "Demo",
      ),
    ).toEqual({
      type: "bezi.thread.activate",
      body: {
        sessionId: "4563e0cc-5d22-4f4a-80a4-3fd5b7308760",
        threadId: "c018a98b-2ffc-42a2-9027-1dc2575052cf",
        title: "Fix page syncing",
        workspaceId: "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f",
        workspaceLabel: "Demo",
      },
    });
  });

  it("does not invent optional thread or workspace identifiers", () => {
    expect(
      explicitThreadSelection(
        {
          id: "4563e0cc-5d22-4f4a-80a4-3fd5b7308760",
          title: "New thread",
        },
        null,
      ),
    ).toEqual({
      type: "bezi.thread.activate",
      body: {
        sessionId: "4563e0cc-5d22-4f4a-80a4-3fd5b7308760",
        title: "New thread",
      },
    });
  });

  it("targets only the workspace chosen by an explicit tap", () => {
    expect(
      explicitWorkspaceSelection({
        id: "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f",
        label: "Demo",
      }),
    ).toEqual({
      type: "bezi.workspace.activate",
      body: {
        workspaceId: "cffd6a63-0ef8-4a7e-9ce5-d588cee6135f",
        label: "Demo",
      },
    });
  });

});
