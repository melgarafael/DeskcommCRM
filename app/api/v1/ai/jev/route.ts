import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET/PATCH /api/v1/ai/jev — o cartão "Jev — decisões rápidas".
 *
 * GET responde, para a organização ativa, as perguntas que o cartão faz na
 * ordem em que as faz: há chave e ela passou no teste? o Jev está ligado, e
 * observando ou decidindo? a empresa tem a IA de sempre para comparar e servir
 * de reserva? e, ligado, o que ele fez na semana e quanto concordou com a IA de
 * sempre.
 *
 * PATCH liga, desliga e troca o modo. Ligar manda cada mensagem que o cliente
 * escreve, uma de cada vez e sem o resto da conversa, a um fornecedor nos EUA, então exige chave validada e, na primeira
 * vez, o aceite explícito do administrador (LGPD, D6), que fica gravado com
 * quem e quando. O interruptor mora em `organizations.settings.jev`
 * (`lib/ai/decisao/config.ts`); a organização vem da sessão, nunca do corpo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { credencialEmUsoPeloJev, PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { gravarConfigDoJev, lerConfigDoJev, type ConfigDoJev } from "@/lib/ai/decisao/config";
import { CHAVES_DO_CLIMA, type MotorDoClima } from "@/lib/ai/decisao/metadados-do-clima";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import { PONTOS_DO_JEV } from "@/lib/ai/pontos/registro";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const [JEV] = PROVEDORES_DE_DECISAO;

const DIAS_DOS_NUMEROS = 7;
const DIAS_DA_CONCORDANCIA = 30;
const MENSAGENS_COMPARADAS_MAX = 500;
/** O teto de linhas por resposta do PostgREST (`max_rows` em `supabase/config.toml`). */
const PAGINA = 1000;
// ponytail: 50 páginas = 50 mil execuções do Jev numa semana; acima disso os
// números saem das primeiras 50 mil da janela. Um agregado em SQL (RPC, com
// migration) é o passo seguinte, quando alguma instalação chegar lá.
const PAGINAS_MAX = 50;

const TAREFAS = PONTOS_DO_JEV.flatMap((p) =>
  p.decisaoRapida ? [{ id: p.id, rotulo: p.rotulo, oQueOJevFaz: p.decisaoRapida.oQueOJevFaz }] : [],
);

interface LinhaDaSemana {
  provider: string;
  status: string;
  origem_da_escolha: string | null;
  error_code: string | null;
  cost_cents: number | null;
  latency_ms: number | null;
  created_at: string;
}

/** Linhas do Jev (as dele e as da reserva que o cobriu), em ordem de criação. */
function numerosDaSemana(linhas: readonly LinhaDaSemana[]) {
  const doJev = linhas.filter((l) => l.provider === PROVEDOR_DO_JEV);
  const medidas = doJev.filter((l) => l.status === "ok");
  const latencias = medidas.flatMap((l) => (l.latency_ms === null ? [] : [l.latency_ms]));
  // Linha sem preço (`null`, versão que o fornecedor devolveu fora da tabela)
  // fica fora da soma e AVISA que a soma está incompleta; sem nenhuma linha com
  // preço, o custo é desconhecido (`null`), como no SUM do SQL — nunca um zero
  // inventado ao lado de N medições.
  const comPreco = doJev.filter((l) => l.cost_cents !== null);
  const custo =
    comPreco.length === 0 && doJev.length > 0
      ? null
      : comPreco.reduce((soma, l) => soma + Number(l.cost_cents), 0);
  const custoIncompleto = comPreco.length < doJev.length;
  // A mais recente pela DATA, não pela posição: a ordem da leitura existe para
  // a paginação, e mudar a ordem não pode trocar a falha que o cartão mostra.
  const maisNova = (atual: LinhaDaSemana | null, l: LinhaDaSemana) =>
    atual === null || Date.parse(l.created_at) > Date.parse(atual.created_at) ? l : atual;
  const ultimaFalha = doJev.filter((l) => l.status === "erro").reduce<LinhaDaSemana | null>(maisNova, null);
  const ultimoSucesso = medidas.reduce<LinhaDaSemana | null>(maisNova, null);
  // Só a falha que o Jev ainda não superou (D3: só alarma o que pede ação). Um
  // 429 passageiro seguido de mil medidas não é notícia pela semana inteira.
  const falha =
    ultimaFalha !== null &&
    (ultimoSucesso === null || Date.parse(ultimaFalha.created_at) > Date.parse(ultimoSucesso.created_at))
      ? ultimaFalha
      : null;
  return {
    numeros: {
      dias: DIAS_DOS_NUMEROS,
      decisoes: medidas.length,
      custo_cents: custo,
      custo_incompleto: custoIncompleto,
      latencia_media_ms:
        latencias.length === 0
          ? null
          : Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length),
      // Só a que MEDIU: a reserva que também falhou não assumiu nada.
      reservas: linhas.filter((l) => l.origem_da_escolha === "reserva_do_jev" && l.status === "ok")
        .length,
    },
    ultima_falha: falha ? { motivo: falha.error_code, em: falha.created_at } : null,
  };
}

/**
 * A nota chamaria uma pessoa? O corte é `DEFAULT_SENTIMENT_THRESHOLD`
 * (`lib/ai/prompts/sentiment.ts:34`), o mesmo que `workers/ai-sentiment-worker.ts`
 * compara (`score < threshold`) para emitir `ai.sentiment_alert`.
 * ponytail: o limiar por agente (`config.sentiment_threshold`) não entra — não
 * tem tela que o grave hoje. Se ganhar, o worker passa a gravar o limiar usado
 * em `messages.metadata` e a conta lê de lá.
 */
const abaixo = (n: number) => n < DEFAULT_SENTIMENT_THRESHOLD;

/**
 * Concordância em observação: as duas notas caíram do MESMO LADO do corte que
 * decide a passagem para humano? É a pergunta que importa antes de deixar o Jev
 * decidir — "chamou uma pessoa quando a IA de sempre chamaria".
 */
function concordancia(linhas: ReadonlyArray<{ nota: unknown; nota_do_jev: unknown }>) {
  const pares = linhas.flatMap((l) =>
    typeof l.nota === "number" && typeof l.nota_do_jev === "number"
      ? [[l.nota, l.nota_do_jev] as const]
      : [],
  );
  return {
    dias: DIAS_DA_CONCORDANCIA,
    comparadas: pares.length,
    concordaram: pares.filter(([ia, jev]) => abaixo(ia) === abaixo(jev)).length,
  };
}

/**
 * "Clientes irritados percebidos": conversas em que a nota DO JEV ficou abaixo
 * do corte da passagem para humano. A nota dele, e não a que decidiu: em
 * observação quem decide é a IA de sempre, e o número do cartão ficaria em zero
 * enquanto o Jev percebe a irritação do mesmo jeito. Conversa, e não mensagem:
 * o cliente irritado que manda três mensagens é um cliente.
 */
function irritadosPercebidos(linhas: ReadonlyArray<{ conversa: unknown; nota_do_jev: unknown }>): number {
  return new Set(
    linhas.flatMap((l) => (typeof l.nota_do_jev === "number" && abaixo(l.nota_do_jev) ? [l.conversa] : [])),
  ).size;
}

function configPublica(c: ConfigDoJev) {
  return { ligado: c.ligado, modo: c.modo, aceite: c.aceite };
}

function diasAtras(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_jev" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();

  const lerSemana = async (): Promise<{ linhas: LinhaDaSemana[]; erro: string | null }> => {
    const linhas: LinhaDaSemana[] = [];
    const desde = diasAtras(DIAS_DOS_NUMEROS);
    for (let pagina = 0; pagina < PAGINAS_MAX; pagina++) {
      const { data, error } = await db
        .from("llm_calls")
        .select("provider, status, origem_da_escolha, error_code, cost_cents, latency_ms, created_at")
        .eq("organization_id", org.orgId)
        .gte("created_at", desde)
        .or(`provider.eq.${PROVEDOR_DO_JEV},origem_da_escolha.eq.reserva_do_jev`)
        // CRESCENTE de propósito: na paginação por posição, a linha que entra
        // durante a leitura cai no fim, e nenhuma página anterior se desloca.
        .order("created_at", { ascending: true })
        .range(pagina * PAGINA, (pagina + 1) * PAGINA - 1);
      if (error) return { linhas, erro: error.message };
      linhas.push(...(data ?? []));
      if ((data ?? []).length < PAGINA) break;
    }
    return { linhas, erro: null };
  };

  const [orgRes, credsRes, semana, comparadasRes, iaDeSempre, percebidasRes] = await Promise.all([
    db.from("organizations").select("settings").eq("id", org.orgId).maybeSingle(),
    db
      .from("ai_provider_credentials")
      .select("id, label, provider, is_active, validated_at, validation_error, created_at")
      .eq("organization_id", org.orgId)
      .eq("provider", PROVEDOR_DO_JEV)
      .eq("is_active", true),
    lerSemana(),
    // ponytail: `messages` não tem índice por (organização, data) — o plano lê
    // as mensagens da organização e filtra. Índice parcial em
    // `metadata ? 'sentiment_jev_score'` (migration) quando pesar.
    db
      .from("messages")
      .select(`nota:metadata->${CHAVES_DO_CLIMA.nota}, nota_do_jev:metadata->${CHAVES_DO_CLIMA.notaDoJev}`)
      .eq("organization_id", org.orgId)
      .gte("created_at", diasAtras(DIAS_DA_CONCORDANCIA))
      .eq(`metadata->>${CHAVES_DO_CLIMA.motor}`, "llm" satisfies MotorDoClima)
      .not(`metadata->${CHAVES_DO_CLIMA.notaDoJev}`, "is", null)
      .order("created_at", { ascending: false })
      .limit(MENSAGENS_COMPARADAS_MAX),
    // A MESMA pergunta que o worker faz antes de medir: sem ela, o cartão diria
    // "a IA de sempre é a reserva" numa empresa em que ninguém a resolve.
    resolverModeloDoPonto("sentiment_classify", org.orgId, DEFAULT_CLASSIFIER_MODEL, {
      naFaltaUsarOPadraoDaOrganizacao: true,
    }),
    // ponytail: uma página (1000 mensagens medidas pelo Jev na semana); acima
    // disso a conta sai das mais recentes. O agregado em SQL é o passo seguinte.
    db
      .from("messages")
      .select(`conversa:conversation_id, nota_do_jev:metadata->${CHAVES_DO_CLIMA.notaDoJev}`)
      .eq("organization_id", org.orgId)
      .gte("created_at", diasAtras(DIAS_DOS_NUMEROS))
      .not(`metadata->${CHAVES_DO_CLIMA.notaDoJev}`, "is", null)
      .order("created_at", { ascending: false })
      .limit(PAGINA),
  ]);

  const erro =
    orgRes.error?.message ??
    credsRes.error?.message ??
    semana.erro ??
    comparadasRes.error?.message ??
    percebidasRes.error?.message;
  if (erro) return fail("query_failed", erro, 500, { requestId });

  const credenciais = credsRes.data ?? [];
  const emUso = credencialEmUsoPeloJev(credenciais);
  // Sem nenhuma validada, o cartão mostra a mais recente — é ela que tem o
  // motivo da recusa para explicar.
  const mostrada =
    emUso ??
    [...credenciais].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ??
    null;

  const { numeros, ultima_falha } = numerosDaSemana(semana.linhas);

  return ok(
    {
      provedor: {
        rotulo: JEV.rotulo,
        quandoUsar: JEV.quandoUsar,
        ondePegarAChave: JEV.ondePegarAChave,
        prefixoDaChave: JEV.prefixoDaChave,
      },
      chave: {
        existe: mostrada !== null,
        validada: emUso !== null,
        credencial_id: mostrada?.id ?? null,
        rotulo: mostrada?.label ?? null,
        erro_de_validacao: mostrada?.validation_error ?? null,
      },
      config: configPublica(lerConfigDoJev(orgRes.data?.settings)),
      tarefas: TAREFAS,
      tem_ia_de_sempre: iaDeSempre !== null,
      numeros: {
        ...numeros,
        irritados: irritadosPercebidos(percebidasRes.data ?? []),
        observacao: concordancia(comparadasRes.data ?? []),
      },
      ultima_falha,
      pode_editar: roleAtLeast(org.role, "admin"),
    },
    { requestId },
  );
}

// `.strict()`: `organization_id` (ou qualquer campo a mais) no corpo é recusado,
// não ignorado — a organização é a da sessão, e ponto.
const corpoDoPatch = z
  .object({
    ligado: z.boolean().optional(),
    modo: z.enum(["observacao", "decide"]).optional(),
    /** A caixa marcada na tela. Só pesa ao ligar pela primeira vez. */
    aceite_lgpd: z.literal(true).optional(),
  })
  .strict()
  .refine((c) => c.ligado !== undefined || c.modo !== undefined, {
    message: "informe `ligado` ou `modo`",
  });

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_jev" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { requestId, details: parsed.error.issues });
  }
  const corpo = parsed.data;

  // Cliente admin: a RLS de `organizations` só deixa ESCREVER platform admin
  // (ver o PATCH de `app/api/v1/ai/providers/route.ts`). O filtro de tenant é
  // deste arquivo, e `org.orgId` vem do `requireRole`.
  const admin = createAdminClient();
  const { data: orgAtual, error: orgErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (orgErr) return fail("query_failed", orgErr.message, 500, { requestId });
  const atual = lerConfigDoJev(orgAtual?.settings);

  const mudanca: Partial<Pick<ConfigDoJev, "ligado" | "modo" | "aceite">> = {};
  if (corpo.modo !== undefined && corpo.modo !== atual.modo) mudanca.modo = corpo.modo;
  if (corpo.ligado === false && atual.ligado) mudanca.ligado = false;
  if (corpo.ligado === true && !atual.ligado) {
    const { data: creds, error: credsErr } = await admin
      .from("ai_provider_credentials")
      .select("provider, is_active, validated_at, created_at")
      .eq("organization_id", org.orgId)
      .eq("provider", PROVEDOR_DO_JEV)
      .eq("is_active", true);
    if (credsErr) return fail("query_failed", credsErr.message, 500, { requestId });
    if (credencialEmUsoPeloJev(creds ?? []) === null) {
      return fail(
        "jev_exige_chave_validada",
        t("Para ligar o Jev, cole a chave dele em Credenciais e espere o teste da chave passar."),
        422,
        { requestId },
      );
    }
    if (atual.aceite === null) {
      if (corpo.aceite_lgpd !== true) {
        return fail(
          "jev_exige_aceite",
          t(
            "Ligar o Jev manda cada mensagem dos clientes, uma de cada vez e sem o resto da conversa, para a TypeSafe AI, nos Estados Unidos. Para ligar, confirme que você está de acordo.",
          ),
          422,
          { requestId },
        );
      }
      mudanca.aceite = { em: new Date().toISOString(), por: user.id };
    }
    mudanca.ligado = true;
  }

  // Pedir o estado que já vale não é mutação: sem escrita e sem auditoria.
  if (Object.keys(mudanca).length === 0) {
    return ok({ config: configPublica(atual), alterado: false }, { requestId });
  }

  const gravado = await gravarConfigDoJev({ admin, orgId: org.orgId, actorUserId: user.id, mudanca });
  if (!gravado.ok) {
    return fail("save_failed", t("nada foi gravado — verifique as permissões da organização"), 500, {
      requestId,
    });
  }

  // Um PATCH é uma mutação, então uma linha — a ação é a mais forte do que mudou.
  void audit({
    action:
      mudanca.ligado === true
        ? "ai.jev.ligado"
        : mudanca.ligado === false
          ? "ai.jev.desligado"
          : "ai.jev.modo_alterado",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: {
      modo: gravado.config.modo,
      ...(mudanca.modo !== undefined ? { modo_anterior: atual.modo } : {}),
      aceite_registrado: mudanca.aceite !== undefined,
    },
  });

  return ok({ config: configPublica(gravado.config), alterado: true }, { requestId });
}
