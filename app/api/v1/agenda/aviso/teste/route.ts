/**
 * POST /api/v1/agenda/aviso/teste — "enviar teste" do aviso de agendamento.
 *
 * Manda de verdade, pela MESMA fila de condições do aviso de caso
 * (`lib/escalacao/aviso-de-teste.ts`): conexão arquivada, parada ou que só
 * manda modelo aprovado, transporte fora do ar, teto do aquecimento, destino
 * que voltou a ser número da organização. Só o texto muda — e, por não levar
 * link, ele não depende do endereço público.
 *
 * Balde PRÓPRIO de três por hora, por organização, separado do teste do aviso
 * de caso: são dois botões em duas telas, e um não deveria esgotar o outro. O
 * número é o mesmo, e o teto diário dele é medido pelo `pacing_ledger` — que
 * o teste também alimenta.
 *
 * Recusa devolve 200 com o motivo, como no aviso de caso: "o teste rodou e não
 * saiu, porque…" é a resposta que o botão pediu.
 *
 * Com um grupo salvo, o teste vai também ao grupo
 * (`lib/agenda/teste-do-aviso-de-agendamento.ts`), e a resposta traz o
 * desfecho dele em `grupo`, separado do número.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { createSupabaseAvisoDeAgendamentoDb } from "@/lib/agenda/aviso-de-agendamento";
import { enviarTesteDoAvisoDeAgendamento } from "@/lib/agenda/teste-do-aviso-de-agendamento";
import { montarTesteDoAvisoDeAgendamento } from "@/lib/agenda/texto-do-aviso-de-agendamento";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { env } from "@/lib/env";
import { createSupabaseAvisoDb, mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TESTES_POR_HORA = 3;
const JANELA_SEGUNDOS = 3600;
const RECURSO = "config_aviso_de_agendamento";

export async function POST(_req: NextRequest): Promise<Response> {
  // PRIMEIRO passo: o teste gasta uma mensagem do número do cliente.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const balde = await checkRateLimit(`aviso-agenda-teste:${orgId}`, TESTES_POR_HORA, JANELA_SEGUNDOS);
  if (!balde.allowed) {
    return fail(
      "rate_limited",
      t("Você já mandou três testes nesta hora. Espere um pouco antes do próximo."),
      429,
      {
        requestId,
        headers: {
          "Retry-After": String(JANELA_SEGUNDOS),
          "X-RateLimit-Limit": String(balde.limit),
          "X-RateLimit-Remaining": String(Math.max(0, balde.limit - balde.count)),
        },
      },
    );
  }

  // A configuração SALVA e em vigor — com "usar o número do aviso de caso"
  // resolvido do mesmo jeito que o envio real resolve. ⚠️ Service role: a
  // organização vem da sessão e `carregaConfig` filtra `organization_id`.
  const admin = createAdminClient();
  const avisoDb = createSupabaseAvisoDb(admin);
  let cfg: Awaited<ReturnType<ReturnType<typeof createSupabaseAvisoDeAgendamentoDb>["carregaConfig"]>>;
  try {
    cfg = await createSupabaseAvisoDeAgendamentoDb(admin, avisoDb).carregaConfig(orgId);
  } catch {
    return fail("internal_error", t("Não foi possível ler a configuração do aviso."), 500, { requestId });
  }
  if (!cfg?.channel_session_id || !cfg.telefone_destino) {
    return fail(
      "aviso_nao_configurado",
      t("Escolha a conexão e o número e salve antes de mandar o teste."),
      422,
      { requestId },
    );
  }

  const resultado = await enviarTesteDoAvisoDeAgendamento(
    {
      db: avisoDb,
      transporte: await criarTransporteDoAviso(admin),
      pacing: await criarPacingDoCanal(admin),
      clock: () => new Date(),
      urlPublica: env.NEXT_PUBLIC_APP_URL,
    },
    {
      organizationId: orgId,
      channelSessionId: cfg.channel_session_id,
      telefone: cfg.telefone_destino,
      grupo: cfg.grupo_destino,
      corpo: (marca) => montarTesteDoAvisoDeAgendamento({ marca: marca.nome, idioma: marca.idioma }),
    },
  );

  // Auditado nos dois desfechos, sem o texto e com o número MASCARADO.
  void audit({
    action: "agenda.aviso_whatsapp_teste",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: RECURSO,
    resourceId: orgId,
    metadata: {
      destino_mascarado: mascara(cfg.telefone_destino),
      canal: cfg.channel_session_id,
      enviado: resultado.enviado,
      ...(resultado.enviado ? {} : { motivo: resultado.codigo }),
      ...(resultado.grupo
        ? {
            grupo_enviado: resultado.grupo.enviado,
            ...(resultado.grupo.enviado ? {} : { motivo_do_grupo: resultado.grupo.codigo }),
          }
        : {}),
    },
  });

  return ok(resultado, { requestId });
}
