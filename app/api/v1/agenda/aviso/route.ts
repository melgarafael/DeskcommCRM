/**
 * GET/PUT /api/v1/agenda/aviso — a configuração do aviso de agendamento no
 * WhatsApp do dono (migration 0753).
 *
 * O desenho é o da rota do aviso de caso (`app/api/v1/ai/cases/alerta`), e
 * pelas mesmas razões, escritas lá por extenso:
 *
 * - **A escrita é do RPC.** `fn_definir_aviso_de_agendamento` faz papel,
 *   suporte, MFA, E.164, conexão da organização, recusa do número da própria
 *   organização e confirmação de número de cliente na MESMA transação.
 * - **…e mesmo assim a guarda de suporte é chamada na primeira linha do PUT**,
 *   porque o gate `tests/unit/suporte-cobertura-de-efeitos.test.ts` casa o
 *   texto desta rota e a próxima versão dela pode deixar de passar pelo RPC.
 * - **`numero_de_cliente` é uma pergunta.** A tela mostra a consequência e
 *   reenvia com `confirma_contato: true`.
 *
 * O PUT limpa o memo do corte de número interno
 * (`lib/escalacao/numero-interno-de-aviso.ts`): o número novo passa a ser
 * interno nesta mesma instância na hora, não depois de 30 s.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { lerEstadoDaTelaDoAvisoDeAgendamento } from "@/lib/agenda/tela-do-aviso-de-agendamento";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const RECURSO = "config_aviso_de_agendamento";

/**
 * Com `usa_numero_do_aviso_de_caso`, conexão e número não são enviados (e são
 * ignorados pelo RPC); sem ele, os dois são obrigatórios — a mesma forma do
 * CHECK da tabela.
 */
const corpo = z
  .object({
    usa_numero_do_aviso_de_caso: z.boolean(),
    channel_session_id: z.string().uuid().nullable().optional(),
    telefone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable()
      .optional(),
    ligado: z.boolean(),
    /** `true` = "eu sei que este número é um cliente meu, e quero mesmo assim". */
    confirma_contato: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.usa_numero_do_aviso_de_caso || (!!d.channel_session_id && !!d.telefone), {
    message: "channel_session_id e telefone são obrigatórios sem o número do aviso de caso",
  });

/** O que cada exceção do RPC vira no wire. Os nomes são contrato da 0753. */
const RECUSAS_DO_RPC = {
  aviso_de_agendamento_forbidden: {
    code: "forbidden_role",
    status: 403 as const,
    frase: "Só quem administra a conta pode configurar o aviso de agendamento.",
  },
  aviso_de_agendamento_mfa_required: {
    code: "mfa_required",
    status: 403 as const,
    frase: "Confirme sua identidade para mudar o aviso de agendamento.",
  },
  aviso_de_agendamento_sem_aviso_de_caso: {
    code: "aviso_sem_aviso_de_caso",
    status: 422 as const,
    frase: "O aviso de caso ainda não tem número. Escolha um número só para a agenda.",
  },
  aviso_de_agendamento_telefone_invalido: {
    code: "validation_failed",
    status: 422 as const,
    frase: "Esse número não é válido. Use o código do país, por exemplo +55 31 99999-8888.",
  },
  aviso_de_agendamento_canal_invalido: {
    code: "aviso_canal_invalido",
    status: 422 as const,
    frase: "A conexão escolhida não existe mais nesta conta. Escolha outra.",
  },
  aviso_de_agendamento_numero_da_propria_org: {
    code: "aviso_numero_da_propria_org",
    status: 422 as const,
    frase:
      "Esse é um dos números conectados da sua conta. Ele não pode receber os avisos, senão um responde ao outro sem parar.",
  },
  aviso_de_agendamento_numero_de_cliente: {
    code: "aviso_numero_de_cliente",
    status: 422 as const,
    frase:
      "Esse número já é de um cliente seu. Se você continuar, as mensagens dele param de chegar ao CRM.",
  },
} as const;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;

  const db = await createClient();
  return ok(await lerEstadoDaTelaDoAvisoDeAgendamento(db, authz.org.orgId), { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  // PRIMEIRO passo: acompanhamento somente-leitura não muda para onde vão os
  // avisos do cliente.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body inválido."), 400, { requestId });
  }
  const parsed = corpo.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Body inválido."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const dados = parsed.data;

  // Client de SESSÃO: o RPC lê `auth.uid()` para saber quem escreve.
  const db = await createClient();
  const { data, error } = await db.rpc(
    "fn_definir_aviso_de_agendamento" as never,
    {
      p_org: authz.org.orgId,
      p_usa_numero_do_aviso_de_caso: dados.usa_numero_do_aviso_de_caso,
      p_channel: dados.usa_numero_do_aviso_de_caso ? null : (dados.channel_session_id ?? null),
      p_telefone: dados.usa_numero_do_aviso_de_caso ? null : (dados.telefone ?? null),
      p_ligado: dados.ligado,
      p_confirma_contato: dados.confirma_contato ?? false,
    } as never,
  );

  if (error) {
    const recusa = Object.entries(RECUSAS_DO_RPC).find(([nome]) => (error.message ?? "").includes(nome))?.[1];
    if (recusa) return fail(recusa.code, t(recusa.frase), recusa.status, { requestId });
    return fail("internal_error", t("Não foi possível salvar o aviso."), 500, { requestId });
  }

  limparCacheDoNumeroInterno();
  const resultado = (data ?? {}) as { trocou_numero?: boolean; antes_ligado?: boolean };

  // O número entra MASCARADO: `api_audit_log` é append-only e a cascata de
  // LGPD não o alcança.
  void audit({
    action: "agenda.aviso_whatsapp_configurado",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: RECURSO,
    resourceId: authz.org.orgId,
    metadata: {
      usa_numero_do_aviso_de_caso: dados.usa_numero_do_aviso_de_caso,
      destino_mascarado: dados.usa_numero_do_aviso_de_caso || !dados.telefone ? null : mascara(dados.telefone),
      canal: dados.usa_numero_do_aviso_de_caso ? null : (dados.channel_session_id ?? null),
      trocou_numero: Boolean(resultado.trocou_numero),
      antes_ligado: Boolean(resultado.antes_ligado),
      depois_ligado: dados.ligado,
      confirmou_contato: dados.confirma_contato ?? false,
    },
  });

  return ok(await lerEstadoDaTelaDoAvisoDeAgendamento(db, authz.org.orgId), { requestId });
}
