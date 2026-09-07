import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/metrics/atrito — o Índice de Atrito (spec 17; doutrina
 * `docs/doctrine/sistema-vivo/03-medida-do-proposito.md`).
 *
 * Mede o PROPÓSITO declarado ("menor atrito possível para os dois lados"), que
 * até aqui não tinha número nenhum: `/metrics/attendants` devolve won, lost,
 * conversas e 1ª resposta — atividade e conversão.
 *
 * Escopo = a PRÓPRIA RLS, igual à rota irmã: `fn_atrito_metrics` é SECURITY
 * INVOKER e roda com o client user-scoped (cookie session), então as seis
 * tabelas lidas já filtram por `fn_user_org_ids()`. A org vem do cookie
 * validado, NUNCA do body/query. Read-only ⇒ sem audit.
 *
 * A RÉGUA DO ABANDONO (Fase 2) vem de `organizations.settings->'atrito'->
 * 'abandono_horas'` (default 72) e volta no payload, para a tela exibi-la junto
 * do número: índice cuja definição muda sem aviso destrói a única coisa que ele
 * tinha, que é comparabilidade no tempo (doutrina §3.4, regra 4).
 *
 * Piso de rota = `agent`, mesmo de `/metrics/attendants`: quem opera precisa
 * enxergar o custo do que opera. Sem filtro por atendente — atrito é
 * propriedade do sistema, não performance individual, e quebrá-lo por pessoa
 * convidaria exatamente o uso que a doutrina §3.6 desaconselha (otimização
 * local que degrada o todo).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  ABANDONO_HORAS_DEFAULT,
  lerAbandonoHoras,
  montarPares,
  type AtritoRaw,
} from "@/lib/metrics/atrito";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/**
 * Shape vazio para org sem dado no período. Os campos que dependem de
 * denominador nascem `null`, nunca `0` — a tela mostra "—". Devolver zero aqui
 * seria afirmar "nenhum atrito" onde o certo é "não medido" (doutrina §3.4).
 */
const VAZIO: Omit<AtritoRaw, "escopo"> = {
  cliente: {
    turnos_p50: null,
    turnos_p90: null,
    insistencia_media: null,
    insistencia_max: null,
    pedidos_de_humano: 0,
    descadastros: 0,
    abandonos: 0,
    conversas_com_fala_nossa: 0,
    reperguntas: 0,
    perguntas_com_resposta: 0,
    esperas_caladas: 0,
    esperas_medidas: 0,
    espera_resposta_p90_s: null,
  },
  empresa: {
    intervencoes_por_demanda: null,
    espera_humana_p50_s: null,
    espera_humana_p90_s: null,
    retrabalho: 0,
    vetos: 0,
    execucoes_medidas: 0,
    envios_por_ia: 0,
    envios_humano_no_sistema: 0,
    envios_humano_fora: 0,
    demandas_sem_proximo_passo: 0,
  },
  eficiencia: { ganhos: 0, perdidos: 0 },
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg, user } = authz;
  const idioma = normalizarIdioma(user.locale);
  const t = (texto: string) => traduzir(texto, idioma);

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", t("Janela inválida: 'from' deve ser anterior a 'to'."), 422, {
      requestId,
    });
  }

  const supabase = await createClient();

  // A RÉGUA é lida pelo ADMIN client com filtro explícito de organization_id
  // (mesmo padrão de /api/v1/settings/routing): `organizations` só aceita
  // escrita de platform admin e a leitura por sessão pode casar 0 linhas — o
  // que faria a régua cair no default em SILÊNCIO, com cara de configuração.
  // A RPC abaixo continua no client de SESSÃO, para herdar a RLS.
  const admin = createAdminClient();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const abandonoHoras = lerAbandonoHoras(orgRow?.settings);

  const { data, error } = await supabase.rpc("fn_atrito_metrics", {
    p_org: activeOrg.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_abandono_horas: abandonoHoras,
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const raw = (data ?? {
    ...VAZIO,
    // `abandono_horas` PRECISA estar aqui: o rótulo do dano interpola a régua e
    // sem ela a tela diria "após undefined h". O cast abaixo apagaria o erro.
    escopo: {
      demandas: 0,
      de: from.toISOString(),
      ate: to.toISOString(),
      abandono_horas: abandonoHoras,
      repeticao_min: 0.7,
      espera_horas: 4,
      demandas_com_caso: 0,
      demandas_abertas: 0,
      denominador: "demandas",
    },
  }) as unknown as AtritoRaw;

  return ok(
    {
      window: { from: from.toISOString(), to: to.toISOString() },
      escopo: raw.escopo,
      regua: { abandono_horas: abandonoHoras, default: ABANDONO_HORAS_DEFAULT },
      pares: montarPares(raw, t),
      // Os componentes crus viajam junto: a doutrina §3.4 regra 2 proíbe
      // agregado sem detalhamento, e é daqui que o drill-down sai.
      componentes: { cliente: raw.cliente, empresa: raw.empresa },
    },
    { requestId },
  );
}

const patchSchema = z.object({
  abandono_horas: z.number().int().min(1).max(24 * 90),
});

/**
 * PATCH — muda a régua do abandono.
 *
 * Piso `manager`, e não `agent`: mudar a régua muda o número de TODOS os
 * períodos exibidos daí em diante. Quem opera precisa ver o custo do que opera
 * (GET em `agent`); redefinir o que conta como perda é decisão de quem responde
 * pelo resultado.
 *
 * Escrita pelo ADMIN client com filtro explícito de organization_id: com o
 * client de sessão o update casa 0 linhas e o PostgREST devolve SUCESSO — a
 * tela diria "salvo" e nada teria sido gravado.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg, user } = authz;

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return fail("validation_failed", t("Corpo inválido."), 422, { requestId });
  }
  const parsed = patchSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail(
      "validation_failed",
      t("A régua do abandono precisa ser um número inteiro de horas entre 1 e 2160."),
      422,
      { details: parsed.error.flatten().fieldErrors as Record<string, unknown>, requestId },
    );
  }

  const admin = createAdminClient();
  const { data: orgRow, error: readErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  // Merge não-destrutivo em dois níveis: preserva as demais chaves de `settings`
  // e as demais chaves de `atrito` (a Fase 3 vai acrescentar réguas aqui).
  const atuais = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const atritoAtual = (atuais.atrito as Record<string, unknown> | null) ?? {};
  const próximas = {
    ...atuais,
    atrito: { ...atritoAtual, abandono_horas: parsed.data.abandono_horas },
  };

  const { error: updErr } = await admin
    .from("organizations")
    .update({ settings: próximas })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  // Mudar a régua muda a leitura histórica do índice — é mutação relevante e
  // vai para o audit (invariante 3).
  void audit({
    action: "metrics.atrito_regua_changed",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { abandono_horas: parsed.data.abandono_horas },
  });

  return ok({ abandono_horas: parsed.data.abandono_horas }, { requestId });
}
