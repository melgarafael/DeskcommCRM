/**
 * GUARDAR O TRUNK SIP DE UMA ORGANIZAÇÃO — o miolo, sem HTTP.
 *
 * Mesmo espírito de lib/ai/credenciais/guardar.ts: cifrar AES-GCM (nunca
 * plaintext em disco), gravar só os últimos 4 dígitos em claro, auditar.
 * Uma linha por organização (upsert em `organization_id`, chave primária) —
 * não é uma lista, é a config de UM trunk.
 *
 * `endpoint_name` é DERIVADO da organização (`org-<uuid>-trunk-endpoint`),
 * não digitado — é o nome da seção que precisa bater, caractere por
 * caractere, com o bloco `[org-<uuid>-trunk-endpoint]` em `asterisk/pjsip.conf`
 * (aplicado manualmente por enquanto, ver migration 0349). Derivar em vez de
 * deixar a pessoa digitar elimina a única forma de os dois lados divergirem.
 */
import { audit } from "@/lib/audit";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import type { createAdminClient } from "@/lib/supabase/admin";

export function nomeDoEndpoint(organizationId: string): string {
  return `org-${organizationId}-trunk-endpoint`;
}

export type ResultadoDeGuardarTrunk =
  | { ok: true }
  | { ok: false; motivo: "senha_obrigatoria_na_criacao" | "cifragem" | "banco"; detalhe?: string };

export interface PedidoDeGuardarTrunk {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  userId: string;
  host: string;
  port: number;
  username: string;
  /** Plaintext, opcional numa atualização (mantém a senha já cifrada se omitida). Obrigatório na primeira vez. */
  password?: string;
  fromDomain: string | null;
  isActive: boolean;
}

export async function guardarTrunk(p: PedidoDeGuardarTrunk): Promise<ResultadoDeGuardarTrunk> {
  const { data: existente, error: fetchErr } = await p.admin
    .from("voip_trunk_settings")
    .select("organization_id")
    .eq("organization_id", p.orgId)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, motivo: "banco", detalhe: fetchErr.message };
  }

  if (!existente && !p.password) {
    return { ok: false, motivo: "senha_obrigatoria_na_criacao" };
  }

  const camposComuns = {
    organization_id: p.orgId,
    host: p.host,
    port: p.port,
    username: p.username,
    from_domain: p.fromDomain,
    endpoint_name: nomeDoEndpoint(p.orgId),
    is_active: p.isActive,
    updated_by: p.userId,
  };

  let camposDeSenha = {};
  if (p.password) {
    let encrypted;
    try {
      encrypted = encryptKey(p.password);
    } catch (err) {
      return { ok: false, motivo: "cifragem", detalhe: err instanceof Error ? err.message : undefined };
    }
    camposDeSenha = {
      password_encrypted: bufToBytea(encrypted.ciphertext),
      password_iv: bufToBytea(encrypted.iv),
      password_tag: bufToBytea(encrypted.tag),
      password_last4: encrypted.last4,
    };
  }

  const { error } = await p.admin
    .from("voip_trunk_settings")
    .upsert({ ...camposComuns, ...camposDeSenha }, { onConflict: "organization_id" });

  if (error) {
    return { ok: false, motivo: "banco", detalhe: error.message };
  }

  await audit({
    action: existente ? "voip_trunk.updated" : "voip_trunk.created",
    actorUserId: p.userId,
    organizationId: p.orgId,
    resourceType: "voip_trunk_settings",
    resourceId: p.orgId,
    metadata: { host: p.host, port: p.port, username: p.username, senha_alterada: !!p.password },
  });

  return { ok: true };
}
