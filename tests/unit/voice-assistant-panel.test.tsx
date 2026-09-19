import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), start: vi.fn(), end: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@elevenlabs/client", () => ({ Conversation: { startSession: mocks.start } }));
import { VoiceAssistantPanel } from "@/app/app/ai/agents/[id]/_components/VoiceAssistantPanel";
import type { VoicePanelData } from "@/lib/ai/voice/schema";
const data: VoicePanelData = {
  provider_label: "ElevenLabs Agents",
  credential_configured: true,
  configured: true,
  status: "ready",
  voices_error: null,
  settings: {
    voice_id: "voice_12345678",
    language: "pt",
    first_message: "Olá, sou uma assistente de IA.",
    system_prompt: "Entenda primeiro o problema da empresa.",
    max_duration_seconds: 300,
  },
  voices: [{ id: "voice_12345678", name: "Clara" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: structuredClone(data) });
  mocks.post.mockResolvedValue({ data: { signed_url: "wss://api.elevenlabs.io/private-session" } });
  mocks.end.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ endSession: mocks.end });
});
afterEach(cleanup);
it("keeps credentials empty and prevents testing unsaved changes", async () => {
  render(<VoiceAssistantPanel agentId="agent" />);
  const opening = await screen.findByLabelText("Primeira mensagem");
  expect(screen.getByLabelText("Chave da API")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Testar com meu microfone" })).toBeEnabled();
  fireEvent.change(opening, { target: { value: "Nova abertura de teste" } });
  expect(screen.getByRole("button", { name: "Testar com meu microfone" })).toBeDisabled();
});
it("starts only after explicit click and uses the private signed URL", async () => {
  render(<VoiceAssistantPanel agentId="agent" />);
  const button = await screen.findByRole("button", { name: "Testar com meu microfone" });
  expect(mocks.start).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  expect(mocks.post).toHaveBeenCalledWith(
    "/api/v1/ai/agents/agent/voice",
    { action: "test" },
    expect.anything(),
  );
  expect(mocks.start.mock.calls[0]![0]).toMatchObject({
    signedUrl: "wss://api.elevenlabs.io/private-session",
    connectionType: "websocket",
  });
  fireEvent.click(screen.getByRole("button", { name: "Encerrar teste" }));
  await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
});
it("does not open a microphone session after cancellation during token loading", async () => {
  let finish!: (value: unknown) => void;
  mocks.post.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<VoiceAssistantPanel agentId="agent" />);
  fireEvent.click(await screen.findByRole("button", { name: "Testar com meu microfone" }));
  fireEvent.click(screen.getByRole("button", { name: "Encerrar teste" }));
  finish({ data: { signed_url: "wss://api.elevenlabs.io/private-session" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Testar com meu microfone" })).toBeEnabled(),
  );
  expect(mocks.start).not.toHaveBeenCalled();
});
it("ends a session that completes SDK startup after the panel unmounts", async () => {
  let finish!: (value: unknown) => void;
  mocks.start.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<VoiceAssistantPanel agentId="agent" />);
  fireEvent.click(await screen.findByRole("button", { name: "Testar com meu microfone" }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
  view.unmount();
  finish({ endSession: mocks.end });
  await waitFor(() => expect(mocks.end).toHaveBeenCalledOnce());
});
it("does not load credentials or mount a test for read-only users", () => {
  render(<VoiceAssistantPanel agentId="agent" readOnly />);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Testar com meu microfone" }),
  ).not.toBeInTheDocument();
});
