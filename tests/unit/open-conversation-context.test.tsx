import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  getOpenConversationId,
  OpenConversationProvider,
} from "@/hooks/notifications/OpenConversationContext";
it("tracks both visible conversations and unregisters only the minimized panel", () => {
  const inbox = render(
    <OpenConversationProvider conversationId="inbox">Inbox</OpenConversationProvider>,
  );
  const dock = render(
    <OpenConversationProvider conversationId="dock">Dock</OpenConversationProvider>,
  );
  expect(getOpenConversationId("inbox")).toBe("inbox");
  expect(getOpenConversationId("dock")).toBe("dock");
  expect(getOpenConversationId("other")).toBeNull();
  dock.rerender(<OpenConversationProvider conversationId={null}>Dock</OpenConversationProvider>);
  expect(getOpenConversationId("dock")).toBeNull();
  expect(getOpenConversationId("inbox")).toBe("inbox");
  dock.unmount();
  inbox.unmount();
  expect(getOpenConversationId()).toBeNull();
});
