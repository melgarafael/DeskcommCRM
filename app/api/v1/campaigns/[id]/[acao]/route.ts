/**
 * POST /api/v1/campaigns/:id/:acao — preparar, iniciar, agendar, pausar,
 * retomar, cancelar, duplicar e testar.
 *
 * ═══ Por que UMA rota e não oito ═══
 *
 * As oito fazem a mesma coisa em volta: conferir papel, carregar a campanha da
 * organização certa, pedir a transição à máquina de estados, auditar. Espalhado
 * em oito arquivos, esse "em volta" diverge — e o dia em que um deles esquecer de
 * conferir o estado é o dia em que uma campanha cancelada volta a enviar. As
 * ações em si moram em `lib/campanhas/acoes.ts`; aqui só há despacho.
 *
 * O caminho na URL continua sendo o da Spec 12 §16 (`/prepare`, `/start`, …, em
 * português): `acao` é validada contra um mapa fechado, então nenhuma URL
 * inventada chega ao banco.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { requireRole } from "@/lib/auth/require-role";
import {
  agendarAcao,
  cancelarAcao,
  carregarCampanha,
  duplicarAcao,
  iniciarAcao,
  pausarAcao,
  prepararAcao,
  testarAcao,
  type Desfecho,
} from "@/lib/campanhas/acoes";
import { agendarSchema, testarSchema } from "@/lib/campanhas/schemas";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ACOES = [
  "preparar",
  "iniciar",
  "agendar",
  "pausar",
  "retomar",
  "cancelar",
  "duplicar",
  "testar",
] as const;

type Acao = (typeof ACOES)[number];

function ehAcao(valor: string): valor is Acao {
  return (ACOES as readonly string[]).includes(valor);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; acao: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id, acao } = await ctx.params;

  if (!ehAcao(acao)) {
    return fail("not_found", t("Ação de campanha desconhecida."), 404, { requestId });
  }

  // Admin client porque duas ações ENVIAM (teste e, por tabela, a preparação
  // lê contatos de toda a organização). Toda consulta filtra `organization_id`
  // à mão, resolvido do papel conferido acima — nunca do corpo.
  const admin = createAdminClient();
  const carregada = await carregarCampanha(admin, authz.org.orgId, id);
  if (!carregada.ok) {
    return fail(carregada.codigo, t(carregada.mensagem), carregada.status, { requestId });
  }
  const campanha = carregada.campanha;
  const agora = new Date();

  let desfecho: Desfecho<Record<string, unknown>>;
  let acaoAuditada: AuditAction | null = null;
  let extra: Record<string, unknown> = {};

  switch (acao) {
    case "preparar": {
      desfecho = await prepararAcao(admin, campanha, agora);
      acaoAuditada = "campaign.prepared";
      break;
    }
    case "iniciar":
    case "retomar": {
      const r = await iniciarAcao(admin, campanha, agora);
      desfecho = r;
      acaoAuditada = r.ok && r.retomada ? "campaign.resumed" : "campaign.started";
      break;
    }
    case "agendar": {
      const parsed = agendarSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return fail("validation_failed", t("Informe a data do agendamento."), 422, { requestId });
      }
      desfecho = await agendarAcao(admin, campanha, new Date(parsed.data.scheduled_at), agora);
      acaoAuditada = "campaign.scheduled";
      extra = { scheduled_at: parsed.data.scheduled_at };
      break;
    }
    case "pausar": {
      desfecho = await pausarAcao(admin, campanha, agora);
      acaoAuditada = "campaign.paused";
      break;
    }
    case "cancelar": {
      desfecho = await cancelarAcao(admin, campanha, agora);
      acaoAuditada = "campaign.cancelled";
      break;
    }
    case "duplicar": {
      desfecho = await duplicarAcao(admin, campanha, authz.user.id);
      acaoAuditada = "campaign.duplicated";
      break;
    }
    case "testar": {
      const parsed = testarSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return fail("validation_failed", t("Escolha um contato para o teste."), 422, { requestId });
      }
      // O fuso é o do NÚMERO (channel_knobs), que é o mesmo que a janela de
      // envio usa — a saudação do teste tem de ser a que o destinatário veria.
      const knobs = await knobsDoCanal(admin, authz.org.orgId, campanha.channel_session_id);
      desfecho = await testarAcao(admin, campanha, parsed.data.contact_id, agora, knobs.timezone);
      acaoAuditada = "campaign.test_sent";
      break;
    }
  }

  if (!desfecho.ok) {
    return fail(desfecho.codigo, t(desfecho.mensagem), desfecho.status, { requestId });
  }

  if (acaoAuditada) {
    void audit({
      action: acaoAuditada,
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "campaign",
      resourceId: campanha.id,
      requestId,
      // Sem telefone, sem texto: id e contagem bastam para responder "quem
      // mandou isso, e quando?".
      metadata: { ...extra, ...semOk(desfecho) },
    });
  }

  return ok(semOk(desfecho), { requestId });
}

/** O corpo da resposta sem o `ok`, que é ruído para quem lê `{ data }`. */
function semOk(d: { ok: true } & Record<string, unknown>): Record<string, unknown> {
  const { ok: _ignorado, ...resto } = d;
  return resto;
}
