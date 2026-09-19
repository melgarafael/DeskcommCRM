import { randomUUID } from "node:crypto";
import {
  assertOwnedPrivateAgent,
  assertVoiceTestConfiguration,
  voicePayload,
  VoiceProviderError,
  type VoiceProvider,
} from "./client";
import { VoiceAssistantError, type VoiceSettings, type VoiceState } from "./schema";

export interface VoiceSyncStore {
  write(state: VoiceState): Promise<void>;
}

/** Caller holds an organization advisory lock. The create intent is committed
 * before HTTP: a timeout/crash is reconciled, never treated as permission to
 * create another remote agent. PATCH is idempotent and safe to repeat. */
export async function syncVoiceAssistant(
  store: VoiceSyncStore,
  provider: Pick<VoiceProvider, "find" | "get" | "create" | "update">,
  name: string,
  previous: VoiceState | null,
  settings: VoiceSettings,
): Promise<VoiceState> {
  let state: VoiceState = previous ?? {
    marker: `crm-voice-${randomUUID()}`,
    remote_agent_id: null,
    status: "rejected",
    settings,
    updated_at: new Date().toISOString(),
  };
  if (!state.remote_agent_id && state.status === "creating") {
    const recovered = await provider.find(state.marker);
    if (!recovered)
      throw new VoiceAssistantError(
        "A criação ainda não foi confirmada. Tente recuperar novamente em instantes. Não criaremos uma cópia enquanto houver dúvida.",
        409,
      );
    state = { ...state, remote_agent_id: recovered, status: "syncing" };
    await store.write(state);
  }
  if (state.remote_agent_id) {
    const remoteId = state.remote_agent_id;
    assertOwnedPrivateAgent(await provider.get(remoteId), state.marker);
    state = { ...state, settings, status: "syncing", updated_at: new Date().toISOString() };
    await store.write(state);
    await provider.update(remoteId, voicePayload(name, state.marker, settings));
  } else {
    state = { ...state, settings, status: "creating", updated_at: new Date().toISOString() };
    await store.write(state);
    try {
      const remoteId = await provider.create(voicePayload(name, state.marker, settings));
      state = { ...state, remote_agent_id: remoteId, status: "syncing" };
      await store.write(state);
    } catch (error) {
      // Only an explicit provider rejection proves that retrying creation is safe.
      if (
        error instanceof VoiceProviderError &&
        [400, 401, 403, 422, 429].includes(error.upstreamStatus ?? 0)
      )
        await store.write({ ...state, status: "rejected" });
      throw error;
    }
  }
  const remote = await provider.get(state.remote_agent_id!);
  assertOwnedPrivateAgent(remote, state.marker);
  assertVoiceTestConfiguration(remote, settings);
  state = { ...state, status: "ready", updated_at: new Date().toISOString() };
  await store.write(state);
  return state;
}
