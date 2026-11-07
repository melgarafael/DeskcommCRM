import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret, decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { fusoValido } from "@/lib/tempo/fusos";
import { requestAmigo } from "./transport";
import { agentOperations, type AgentOperation } from "./agent-permissions";
import { AmigoDomainError } from "./access";

export interface AmigoSafeConfig {
  configured: boolean;
  active: boolean;
  connection_id: string | null;
  token_last4: string | null;
  validated_at: string | null;
  default_place_id: number | null;
  timezone: string;
  allow_same_day?: boolean;
  months_ahead?: 3 | 6;
  reminders_enabled: boolean;
  agent_operations?: AgentOperation[];
  last_sync_at: string | null;
  last_error: string | null;
}
export interface AmigoConfigInput {
  token?: string;
  active?: boolean;
  default_place_id?: number;
  timezone?: string;
  allow_same_day?: boolean | null;
  months_ahead?: 3 | 6 | null;
  reminders_enabled?: boolean;
  agent_operations?: AgentOperation[];
}
const inputSchema = z
  .object({
    token: z.string().trim().min(1).max(8192).optional(),
    active: z.boolean().optional(),
    default_place_id: z.number().int().positive().optional(),
    timezone: z.string().min(1).refine(fusoValido).optional(),
    allow_same_day: z.boolean().nullable().optional(),
    months_ahead: z
      .union([z.literal(3), z.literal(6)])
      .nullable()
      .optional(),
    reminders_enabled: z.boolean().optional(),
    agent_operations: z
      .array(z.enum(agentOperations))
      .max(agentOperations.length)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
  })
  .strict();
const SAFE_COLUMNS =
  "id,active,token_last4,validated_at,default_place_id,timezone,allow_same_day,months_ahead,reminders_enabled,agent_operations,last_sync_at,last_error";
type ConnectionRow = {
  id: string;
  active: boolean;
  token_last4: string | null;
  validated_at: string | null;
  default_place_id: number | null;
  timezone: string;
  allow_same_day: boolean | null;
  months_ahead: 3 | 6 | null;
  reminders_enabled: boolean;
  agent_operations: unknown;
  last_sync_at: string | null;
  last_error: string | null;
};
function safeConfig(row: ConnectionRow | null): AmigoSafeConfig {
  if (!row)
    return {
      configured: false,
      active: false,
      connection_id: null,
      token_last4: null,
      validated_at: null,
      default_place_id: null,
      timezone: "America/Sao_Paulo",
      reminders_enabled: false,
      last_sync_at: null,
      last_error: null,
    };
  return {
    configured: !!row.token_last4 && !!row.validated_at,
    active: row.active,
    connection_id: row.id,
    token_last4: row.token_last4,
    validated_at: row.validated_at,
    default_place_id: row.default_place_id,
    timezone: row.timezone,
    ...(row.allow_same_day == null ? {} : { allow_same_day: row.allow_same_day }),
    ...(row.months_ahead == null ? {} : { months_ahead: row.months_ahead }),
    reminders_enabled: row.reminders_enabled,
    ...(row.agent_operations == null
      ? {}
      : {
          agent_operations:
            z.array(z.enum(agentOperations)).safeParse(row.agent_operations).data ?? [],
        }),
    last_sync_at: row.last_sync_at,
    // Never forward arbitrary remote errors/PII from storage to a config response.
    last_error: row.last_error
      ? "Não foi possível sincronizar com o Amigo. Teste a conexão."
      : null,
  };
}
async function currentConnection(
  orgId: string,
  connectionId?: string,
): Promise<ConnectionRow | null> {
  let query = createAdminClient()
    .from("amigo_connections")
    .select(SAFE_COLUMNS)
    .eq("organization_id", orgId);
  if (connectionId) query = query.eq("id", connectionId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error?.code === "42P01" || error?.code === "PGRST205") return null;
  if (error)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível ler a configuração Amigo.",
    );
  return data as ConnectionRow | null;
}
/** Caller supplies organization from authenticated context, never from a request body. */
export async function getAmigoConfig(orgId: string): Promise<AmigoSafeConfig> {
  return safeConfig(await currentConnection(orgId));
}
/** Fixed, privileged DDL; never called by GET. */
export async function provisionAmigo(): Promise<void> {
  const { error } = await createAdminClient().rpc("fn_provision_amigo");
  if (error)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível preparar o módulo Amigo.",
    );
}
async function validatedPlaces(token: string): Promise<Array<{ id: number }>> {
  try {
    return z
      .array(z.object({ id: z.number().int().positive() }))
      .parse((await requestAmigo(token, "places", {})).data);
  } catch {
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível validar o token Amigo. Teste a credencial e tente novamente.",
    );
  }
}
/** Session-derived actor/org only. Route also enforces support/MFA before calling. */
export async function saveAmigoConfig(
  orgId: string,
  actorId: string,
  input: AmigoConfigInput,
): Promise<AmigoSafeConfig> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Configuração Amigo inválida. Confira unidade, fuso e opções.",
    );
  const admin = createAdminClient();
  const { data: member, error: memberError } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", actorId)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (memberError || member?.role !== "admin")
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Somente administrador da organização pode configurar o Amigo.",
    );
  const { token, ...options } = parsed.data;
  let ciphertext: string | null = null;
  const patch: Record<string, unknown> = { ...options };
  let expectedConnection: string | null = null;
  if (token !== undefined) {
    const places = await validatedPlaces(token);
    if (
      options.default_place_id !== undefined &&
      !places.some((place) => place.id === options.default_place_id)
    ) {
      throw new AmigoDomainError(
        "amigo_configuration",
        422,
        "Escolha uma unidade disponível nesta conta Amigo.",
      );
    }
    ciphertext = await encryptWebhookSecret(admin, token);
    if (!ciphertext)
      throw new AmigoDomainError(
        "amigo_configuration",
        422,
        "A cifra está indisponível. Configure a chave de criptografia do servidor antes de salvar.",
      );
    patch.token_last4 = token.slice(-4);
    // Even a valid new token may belong to a different clinic. Require explicit activation later.
    patch.active = false;
  } else {
    const current = await currentConnection(orgId);
    expectedConnection = current?.id ?? null;
    if (
      options.active &&
      (!current?.validated_at ||
        !current.token_last4 ||
        !(options.default_place_id ?? current.default_place_id) ||
        !fusoValido(options.timezone ?? current.timezone))
    ) {
      throw new AmigoDomainError(
        "amigo_configuration",
        422,
        "Valide o token e escolha a unidade e o fuso antes de ativar o Amigo.",
      );
    }
    if (options.active || options.default_place_id !== undefined) {
      const loaded = await loadAmigoConnection(orgId);
      if (!loaded || loaded.id !== expectedConnection)
        throw new AmigoDomainError(
          "amigo_configuration",
          422,
          "A conexão Amigo mudou. Atualize a configuração.",
        );
      const places = await validatedPlaces(loaded.token);
      if (
        !places.some(
          (place) => place.id === (options.default_place_id ?? current?.default_place_id),
        )
      ) {
        throw new AmigoDomainError(
          "amigo_configuration",
          422,
          "Escolha uma unidade disponível nesta conta Amigo.",
        );
      }
    }
  }
  await provisionAmigo();
  const { data, error } = await admin.rpc("fn_amigo_save_config", {
    p_org: orgId,
    p_actor: actorId,
    p_input: patch,
    p_ciphertext: ciphertext,
    p_connection: expectedConnection,
  });
  if (error || !data)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível salvar a configuração Amigo.",
    );
  return safeConfig(data as ConnectionRow);
}
/** Privileged boundary: caller must authorize disconnect before invoking this function. */
export async function disconnectAmigo(orgId: string): Promise<void> {
  const { error } = await createAdminClient().rpc("fn_amigo_disconnect", { p_org: orgId });
  if (error)
    throw new AmigoDomainError("amigo_configuration", 422, "Não foi possível desconectar o Amigo.");
}
/** Secret gateway: only an already-authorized backend service may call this. Inactive configured connections are returned for testing. */
export async function loadAmigoConnection(
  orgId: string,
  connectionId?: string,
): Promise<(AmigoSafeConfig & { id: string; token: string }) | null> {
  const row = await currentConnection(orgId, connectionId);
  if (!row || !row.token_last4 || !row.validated_at) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("amigo_credentials")
    .select("ciphertext")
    .eq("organization_id", orgId)
    .eq("connection_id", row.id)
    .maybeSingle();
  if (error || !data)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível ler a credencial Amigo.",
    );
  const token = await decryptWebhookSecret(admin, data.ciphertext as string);
  if (!token)
    throw new AmigoDomainError(
      "amigo_configuration",
      422,
      "Não foi possível abrir a credencial Amigo. Confira a chave de criptografia do servidor.",
    );
  return { ...safeConfig(row), id: row.id, token };
}
