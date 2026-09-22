import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiDialButton } from "./AiDialButton";

const startAiCall = vi.fn();
const voice = { configured: true, paired: true };

vi.mock("@/components/voice/VoiceCallContext", () => ({
  useVoiceCall: () => ({ call: null, startAiCall }),
}));
vi.mock("@/hooks/voice/useVoiceSessionStatus", () => ({
  useVoiceSessionStatus: () => ({ data: voice }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));

describe("ligação com IA no Inbox", () => {
  beforeEach(() => startAiCall.mockClear());

  it("aparece com WaCalls pareado e chama a conversa certa", () => {
    render(
      <AiDialButton
        conversationId="conversation-1"
        contactId="contact-1"
        hasPhone
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ligar com IA" }));
    expect(startAiCall).toHaveBeenCalledWith("conversation-1", "contact-1");
  });

  it("não promete a ligação quando o WaCalls não está pareado", () => {
    voice.paired = false;
    const { container } = render(
      <AiDialButton
        conversationId="conversation-1"
        contactId="contact-1"
        hasPhone
      />,
    );
    expect(container).toBeEmptyDOMElement();
    voice.paired = true;
  });
});
