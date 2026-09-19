import type pg from "pg";
import { encryptKey, decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";
import { VoiceProvider, assertOwnedPrivateAgent, assertVoiceTestConfiguration } from "./client";
import { syncVoiceAssistant } from "./sync";
import {
  voiceStateSchema,
  VoiceAssistantError,
  type VoiceAction,
  type VoicePanelData,
  type VoiceState,
} from "./schema";

const CREDENTIAL_LABEL = "Assistentes de voz";
interface AgentData {
  name: string;
  system_prompt: string;
  voice_state: unknown;
}

async function readAgent(db: pg.PoolClient, org: string, id: string): Promise<AgentData> {
  const { rows } = await db.query<AgentData>(
    `select a.name, coalesce(v.system_prompt,a.system_prompt) as system_prompt,
       a.config->'voice_assistant' as voice_state
     from ai_agents a left join lateral (
       select system_prompt from ai_agent_versions
       where organization_id=$1 and agent_id=a.id and (status='draft' or id=a.published_version_id)
       order by version_number desc limit 1
     ) v on true where a.organization_id=$1 and a.id=$2 and a.archived_at is null`,
    [org, id],
  );
  if (!rows[0]) throw new VoiceAssistantError("Agente não encontrado nesta organização.", 404);
  return rows[0];
}
function savedState(agent: AgentData): VoiceState | null {
  if (agent.voice_state == null) return null;
  const parsed = voiceStateSchema.safeParse(agent.voice_state);
  if (!parsed.success)
    throw new VoiceAssistantError(
      "A configuração de voz precisa de revisão. Nenhum vínculo externo foi alterado.",
      409,
    );
  return parsed.data;
}
async function readKey(db: pg.PoolClient, org: string) {
  const { rows } = await db.query<{
    api_key_encrypted: unknown;
    api_key_iv: unknown;
    api_key_tag: unknown;
  }>(
    `select api_key_encrypted,api_key_iv,api_key_tag from ai_provider_credentials
      where organization_id=$1 and provider='elevenlabs' and label=$2 and is_active=true and validated_at is not null`,
    [org, CREDENTIAL_LABEL],
  );
  if (!rows[0]) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(rows[0].api_key_encrypted),
      iv: byteaToBuffer(rows[0].api_key_iv),
      tag: byteaToBuffer(rows[0].api_key_tag),
    });
  } catch {
    throw new VoiceAssistantError(
      "Não foi possível abrir a chave de voz. Cadastre a chave novamente.",
      422,
    );
  }
}
async function writeState(db: pg.PoolClient, org: string, id: string, state: VoiceState) {
  const result = await db.query(
    `update ai_agents set config=jsonb_set(coalesce(config,'{}'::jsonb),'{voice_assistant}',$3::jsonb),updated_at=now()
     where organization_id=$1 and id=$2 and archived_at is null returning id`,
    [org, id, JSON.stringify(state)],
  );
  if (result.rowCount !== 1)
    throw new VoiceAssistantError(
      "O agente foi alterado ou arquivado. Atualize a página antes de continuar.",
      409,
    );
}

export async function readVoicePanel(
  pool: pg.Pool,
  org: string,
  id: string,
): Promise<VoicePanelData> {
  const db = await pool.connect();
  let agent: AgentData, key: string | null;
  try {
    agent = await readAgent(db, org, id);
    key = await readKey(db, org);
  } finally {
    db.release();
  }
  const state = savedState(agent);
  let voices: VoicePanelData["voices"] = [],
    voicesError: string | null = null;
  if (key) {
    try {
      voices = await new VoiceProvider(key).voices();
    } catch (error) {
      voicesError =
        error instanceof VoiceAssistantError
          ? error.message
          : "Não foi possível carregar as vozes. Tente novamente.";
    }
  }
  return {
    provider_label: "ElevenLabs Agents",
    credential_configured: !!key,
    configured: state?.status === "ready",
    status: state?.status ?? null,
    settings: state?.settings ?? {
      voice_id: "",
      language: "pt",
      first_message: `Olá! Sou ${agent.name}, assistente de inteligência artificial. Como posso ajudar?`,
      system_prompt: agent.system_prompt,
      max_duration_seconds: 300,
    },
    voices,
    voices_error: voicesError,
  };
}

export async function performVoiceAction(
  pool: pg.Pool,
  org: string,
  userId: string,
  id: string,
  input: VoiceAction,
) {
  const db = await pool.connect();
  const lock = `voice-assistant:${org}`;
  let locked = false,
    releaseError: Error | undefined;
  try {
    const { rows: locks } = await db.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
      [lock],
    );
    locked = locks[0]?.locked === true;
    if (!locked)
      throw new VoiceAssistantError(
        "Outra configuração de voz está em andamento. Aguarde e tente novamente.",
        409,
      );
    const agent = await readAgent(db, org, id);
    if (input.action === "credential") {
      const provider = new VoiceProvider(input.api_key);
      await provider.voices();
      // Agent-list requires Agents permission, unlike the voices catalog.
      await provider.find("crm-voice-validation");
      let encrypted;
      try {
        encrypted = encryptKey(input.api_key);
      } catch {
        throw new VoiceAssistantError(
          "A instalação não conseguiu proteger a chave. Verifique a configuração de criptografia.",
          503,
        );
      }
      await db.query(
        `insert into ai_provider_credentials(organization_id,provider,label,api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,validated_at,is_active,created_by)
         values($1,'elevenlabs',$2,$3,$4,$5,$6,now(),true,$7)
         on conflict(organization_id,provider,label) do update set api_key_encrypted=excluded.api_key_encrypted,
         api_key_iv=excluded.api_key_iv,api_key_tag=excluded.api_key_tag,api_key_last4=excluded.api_key_last4,
         validated_at=now(),validation_error=null,is_active=true,updated_at=now()`,
        [
          org,
          CREDENTIAL_LABEL,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.last4,
          userId,
        ],
      );
      return { credential_configured: true };
    }
    const key = await readKey(db, org);
    if (!key)
      throw new VoiceAssistantError("Conecte sua conta ElevenLabs antes de configurar a voz.");
    const provider = new VoiceProvider(key);
    const state = savedState(agent);
    if (input.action === "configure") {
      const voices = await provider.voices();
      if (!voices.some((voice) => voice.id === input.settings.voice_id))
        throw new VoiceAssistantError("Escolha uma voz disponível nesta conta.");
      const result = await syncVoiceAssistant(
        { write: (s) => writeState(db, org, id, s) },
        provider,
        agent.name,
        state,
        input.settings,
      );
      return { configured: true, status: result.status };
    }
    if (!state?.remote_agent_id || state.status !== "ready")
      throw new VoiceAssistantError("Salve e confirme a configuração de voz antes de testar.", 409);
    const remote = await provider.get(state.remote_agent_id);
    assertOwnedPrivateAgent(remote, state.marker);
    assertVoiceTestConfiguration(remote, state.settings);
    return { signed_url: await provider.signedUrl(state.remote_agent_id) };
  } finally {
    if (locked) {
      try {
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [lock]);
      } catch {
        releaseError = new Error("voice_advisory_unlock_failed");
      }
    }
    db.release(releaseError);
  }
}
