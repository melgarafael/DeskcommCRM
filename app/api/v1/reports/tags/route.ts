/**
 * GET /api/v1/reports/tags — o RELATÓRIO POR ETIQUETA (fatia F1 da #1833):
 * qual assunto ocupou a operação neste período, e quanto tempo ele esperou.
 *
 * ## Uma pergunta, três números — e nada além (invariante 5)
 *
 * `lib/reports/atividades.ts` já escreveu a régua na cabeça do próprio relatório:
 * *"um relatório que mostra tudo não responde nada… número que não muda uma
 * decisão é ruído"*. Por etiqueta saem só VOLUME (`conversas`), DESFECHO
 * (`abertas`/`resolvidas`) e ESPERA (`espera_media_segundos`), mais `fatia` —
 * volume já com denominador declarado, para a barra não inventar o seu.
 * Canal, atendente, dia e valor ficam DE FORA: são outras perguntas, com outras
 * rotas (`/metrics/attendants`, `/reports/activities`, `/metrics/lost`).
 *
 * ## Por que a fonte é `conversations.tags`, e não `crm_lead_activities`
 *
 * O relatório de atividades responde *"o que aconteceu, e quem fez — gente ou
 * máquina"* a partir de `crm_lead_activities`, que **não tem coluna de conversa**
 * (a issue mediu: só `actor_kind`, `actor_agent_id`, `evidence` e `reason` foram
 * acrescentados). Grudar as duas perguntas numa tabela só inventaria um join que
 * não existe. O relatório por etiqueta lê `conversations` — `tags text[]` com
 * índice GIN (migration 0033), a mesma coluna que o operador preenche o dia
 * inteiro e que até aqui não virava número nenhum.
 *
 * ## A dimensão vem do que EXISTE, nunca do que foi sugerido
 *
 * A lista de linhas sai de `fn_tags_de_conversa_em_uso(p_org)` (migration 0244,
 * SECURITY INVOKER): é o que `git grep` do filtro já usa. A lista canônica
 * (`organizations.settings.canonical_conversation_tags`) é semente de seletor, e
 * a armadilha 1 da proposta é literalmente o relatório que devolve zero para
 * etiqueta que ninguém usa enquanto a etiqueta visível na tela não aparece.
 * Etiqueta em uso SEM conversa no período continua na lista, com `0` — sumir da
 * lista seria o mesmo defeito com outra roupa.
 *
 * ## A espera: a coluna da Fila, e o que ela mede de fato
 *
 * `espera_media_segundos` parte de `awaiting_since`, a coluna que ordena a Fila
 * (#990, migration 0267). Ela tem DOIS sentidos, e a média herda os dois:
 * - com a bola na equipe, é a mensagem do cliente mais antiga sem resposta, e a
 *   espera corre até `agora` — só aqui a régua coincide com o `avg_wait_seconds`
 *   do painel, que olha quem está na fila;
 * - depois de uma resposta, a coluna vira `last_inbound_at`
 *   (`fn_mark_conversation_message` e `messages/_handler.ts`), e a espera mede da
 *   ÚLTIMA mensagem do cliente até a nossa última resposta — não da primeira.
 * Conversa ENCERRADA com mensagem do cliente sem resposta termina a espera em
 * `service_closed_at`, nunca em `agora`: encerrar não mexe em `awaiting_since`, e
 * contar até `agora` faria o relatório de um mês passado crescer a cada recarga.
 * Sem `awaiting_since` (ou encerrada sem carimbo de encerramento) a conversa não
 * entra na média: `null` é "não medido", e não `0` (a doutrina do
 * `/metrics/atrito` proíbe zero onde o certo é —).
 *
 * **Isto NÃO é `first_human_out − first_in`**, a "1ª resposta" de
 * `fn_attendant_metrics`. Essa exige ler `messages` e paginar a tabela inteira do
 * período — outra fatia, com outro custo, e declarada aqui para não virar número
 * que a tela lê com um nome que não é o seu.
 *
 * ## Escopo: a própria RLS, e por isso o client é o da SESSÃO
 *
 * Client de sessão + `.eq("organization_id", …)` explícito em toda leitura: a
 * policy de `conversations` faz o recorte (agente em modo `own` vê só o próprio),
 * e a doutrina manda o inquilino dito em voz alta em vez de terceirizado.
 * Trocar pelo admin "porque é só leitura" derrubaria o recorte sem erro nenhum na
 * tela. Read-only ⇒ sem audit: a doutrina cobre POST/PATCH/DELETE.
 *
 * ## Sem migração ⇒ a conta é aqui, e a paginação também
 *
 * F1 não cria função no banco, então a agregação roda na aplicação — e é por
 * isso que a leitura paginar: o `max_rows = 1000` (`supabase/config.toml`) corta
 * a resposta SEM avisar, e um total somado sobre uma página viria com cara de
 * certo (a mesma medição que o `/reports/financeiro` registrou: R$ 141.436 em
 * vez de R$ 641.103,60). Aqui o `count` exato diz o tamanho, as páginas andam
 * com `ORDER BY` (sem ele o lote é arbitrário e muda com o plano) e o que não
 * coube chega à tela como `truncado: true`, nunca como número exato.
 *
 * O corte: `sem_dados` com `motivo`, e não uma tabela de zeros — etiqueta com
 * zero AINDA aparece quando o período tem dado, mas período sem nenhuma conversa
 * com etiqueta não devolve linhas vazias fingindo que é relatório.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { STATUS_ENCERRADOS } from "@/lib/inbox/comando-da-conversa";
import { dataNoFuso, inicioDoDia, proximoDia } from "@/lib/relatorios/janela";
import { fusoValido } from "@/lib/reports/atividades";
import { lerPaginado } from "@/lib/supabase/pagina";

export const dynamic = "force-dynamic";

/**
 * Quantos dias a janela pode cobrir. Mesma ordem de grandeza de
 * `/reports/activities` (90): sem migração a leitura varre linhas, e um "desde
 * sempre" chegaria pela query string de qualquer um.
 */
const DIAS_MAXIMOS = 90;

const PAGINAS_MAXIMAS = 10;
const MAXIMO_DE_TAGS_PEDIDAS = 100;

const querySchema = z.object({
  // `iso.date` confere o CALENDÁRIO, não só o formato: `2026-99-99` passava no
  // regex, dava `NaN` dias, furava o teto de 90 e virava janela até 2034.
  de: z.iso.date({ message: "Data inicial inválida." }).optional(),
  ate: z.iso.date({ message: "Data final inválida." }).optional(),
  /**
   * Fuso de quem lê. A janela é DIÁRIA no fuso do leitor, e sem o fuso ela é
   * diária em UTC: `?de=2026-09-01&tz=America/Sao_Paulo` começa à meia-noite de
   * Brasília (03:00Z), e sem `tz` à meia-noite UTC — três horas de conversa
   * nascem ou desaparecem conforme o país de quem olha.
   */
  tz: z.string().min(1).max(64).default("UTC").refine(fusoValido, {
    message: "Fuso horário desconhecido.",
  }),
  tags: z.string().max(4000).optional(),
});

interface ConversaBruta {
  id: string;
  organization_id: string;
  tags: string[] | null;
  status: string;
  created_at: string;
  service_started_at: string | null;
  service_closed_at: string | null;
  awaiting_since: string | null;
  last_outbound_at: string | null;
}

/** O que a rota entrega por etiqueta — invariante 5: volume, espera, desfecho. */
interface LinhaDeEtiqueta {
  etiqueta: string;
  conversas: number;
  abertas: number;
  resolvidas: number;
  /** `null` = nenhuma conversa da etiqueta tinha espera mensurável. */
  espera_media_segundos: number | null;
  /** 0–100, já arredondado — a barra não recalcula nem inventa denominador. */
  fatia: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Piso `viewer`: é leitura, e quem restringe por atendente é a RLS, não o
  // papel — mesmo contrato de `/reports/activities`.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "reports",
    role: "viewer",
    scope: "mcp:read",
    // O token lê a organização inteira; na sessão a RLS restringe por atendente.
    tokenRole: "manager",
  });
  if (!authz.ok) return authz.response;
  // Está em PUBLIC_PATHS: o teto do token é a única contagem das chamadas dele.
  const teto = await tetoDeEscritaDoToken(authz, "reports", requestId);
  if (teto) return teto;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
    tz: url.searchParams.get("tz") ?? undefined,
    // `getAll` + junção: a lista pode chegar repetida (`?tags=a&tags=b`) ou
    // separada por vírgula (`?tags=a,b`) — os dois formatos valem um só pedido.
    tags: url.searchParams.getAll("tags").join(","),
  });
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      requestId,
    });
  }

  const { tz } = parsed.data;
  const hoje = dataNoFuso(new Date(), tz);
  const deTexto = parsed.data.de ?? `${hoje.slice(0, 7)}-01`;
  const ateTexto = parsed.data.ate ?? hoje;

  if (deTexto > ateTexto) {
    // Invertido devolveria lista vazia, e lista vazia lê como "não houve
    // atendimento" — a resposta errada mais convincente que este relatório dá.
    return fail("validation_failed", "A data inicial é depois da final.", 422, { requestId });
  }
  const dias = diasDeJanela(deTexto, ateTexto);
  if (dias > DIAS_MAXIMOS) {
    return fail(
      "validation_failed",
      `Janela de ${dias} dias: o relatório por etiqueta cobre no máximo ${DIAS_MAXIMOS}.`,
      422,
      { requestId },
    );
  }

  const pedidas = etiquetasPedidas(parsed.data.tags);
  if (pedidas.length > MAXIMO_DE_TAGS_PEDIDAS) {
    return fail(
      "validation_failed",
      `Muitas etiquetas pedidas (${pedidas.length}): o teto é ${MAXIMO_DE_TAGS_PEDIDAS}.`,
      422,
      { requestId },
    );
  }

  // Semiaberta [de, até): o fim é o começo do dia SEGUINTE, para "ate=hoje"
  // incluir as conversas de hoje inteiras.
  const janela = {
    de: inicioDoDia(deTexto, tz).toISOString(),
    ate: inicioDoDia(proximoDia(ateTexto), tz).toISOString(),
  };

  // Token: cliente de serviço, sem RLS; o `p_org` e o filtro abaixo são a barreira.
  const supabase = authz.supabase;

  // ─── A DIMENSÃO ────────────────────────────────────────────────────────────
  //
  // `security invoker` + `p_org` da SESSÃO: quem passa o uuid de outra
  // organização recebe zero linhas pelo banco, sem depender de a rota se
  // comportar. O erro SOBE — engolir devolveria "sem dados" para um problema de
  // leitura, que é a mentira mais cara deste relatório.
  const { data: emUso, error: erroDimensao } = await supabase.rpc(
    "fn_tags_de_conversa_em_uso",
    { p_org: authz.organizationId },
  );
  if (erroDimensao) return fail("internal_error", erroDimensao.message, 500, { requestId });
  const dimensaoDoBanco = ((emUso ?? []) as Array<{ tag: string }>)
    .map((linha) => linha.tag)
    .filter((tag) => typeof tag === "string" && tag.length > 0);

  // ─── AS CONVERSAS DO PERÍODO ───────────────────────────────────────────────
  //
  // A régua é "o ATENDIMENTO começou no período" (`service_started_at`), não
  // `created_at`: a conversa é um fio único por contato e sessão de canal
  // (`uniq_conversations_1to1_per_contact_session`), e quem volta reabre o MESMO
  // fio com `service_started_at` novo e o `created_at` de quando falou pela
  // primeira vez — por `created_at`, a reclamação de setembro de quem conversa
  // desde junho sumiria de setembro. Fio sem atendimento carimbado (grupo, ou
  // conversa que ainda não recebeu mensagem do cliente) cai em `created_at`.
  // Limites declarados: o fio guarda só o ÚLTIMO começo, então um atendimento
  // anterior de um fio reaberto depois do período conta no período da
  // reabertura; e as etiquetas acumulam no fio, não por atendimento.
  // Ordenado DESC: se a leitura for cortada, sobra o período mais RECENTE — um
  // relatório que não completa o corte prefere mentir sobre o passado distante
  // do que sobre a semana que o gestor está olhando.
  const COLUNAS =
    "id, organization_id, tags, status, created_at, service_started_at, service_closed_at, awaiting_since, last_outbound_at";
  const naJanela =
    `and(service_started_at.gte.${janela.de},service_started_at.lt.${janela.ate}),` +
    `and(service_started_at.is.null,created_at.gte.${janela.de},created_at.lt.${janela.ate})`;
  const leitura = await lerPaginado<ConversaBruta>(async (inicio, fim, contar) => {
    const { data, error, count } = await supabase
      .from("conversations")
      .select(COLUNAS, contar ? { count: "exact" } : undefined)
      .eq("organization_id", authz.organizationId)
      .or(naJanela)
      .order("service_started_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(inicio, fim);
    return { data: (data ?? []) as unknown as ConversaBruta[], error, count };
  }, PAGINAS_MAXIMAS);
  if (leitura.erro !== null) return fail("internal_error", leitura.erro, 500, { requestId });
  const { linhas: conversas, truncado } = leitura;

  // ─── A CONTA ───────────────────────────────────────────────────────────────
  const agora = Date.now();
  const porEtiqueta = agregar(conversas, agora);

  const chaves = [...new Set([...dimensaoDoBanco, ...porEtiqueta.keys(), ...pedidas])]
    // Pedido filtra: quem pediu duas etiquetas não quer a lista inteira — mas a
    // pedida que não tem conversa NENHUMA no período continua aqui (zerada).
    .filter((tag) => pedidas.length === 0 || pedidas.includes(tag))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // O corte: sem linha nenhuma, a resposta DIZ que não há dados. Duas portas
  // para a mesma ausência, e as duas são pergunta, não tabela.
  if (chaves.length === 0) {
    return ok(montarResposta(janela, tz, [], "nenhuma_etiqueta_em_uso", truncado), { requestId });
  }

  const linhas: LinhaDeEtiqueta[] = chaves.map((etiqueta) => {
    const conta = porEtiqueta.get(etiqueta) ?? zerada();
    return {
      etiqueta,
      conversas: conta.conversas,
      abertas: conta.abertas,
      resolvidas: conta.resolvidas,
      espera_media_segundos:
        conta.medidas > 0 ? Math.round(conta.somaEsperaMs / conta.medidas / 1000) : null,
      fatia: 0,
    };
  });

  const totalEtiquetagens = linhas.reduce((soma, l) => soma + l.conversas, 0);
  if (totalEtiquetagens === 0) {
    return ok(
      montarResposta(janela, tz, [], "nenhuma_conversa_com_etiqueta_no_periodo", truncado),
      { requestId },
    );
  }

  // Round each share down, then give the remaining points to the largest
  // fractional shares so the displayed percentages add up to 100.
  const restos = linhas.map((linha) => {
    const pontos = linha.conversas * 100;
    linha.fatia = Math.floor(pontos / totalEtiquetagens);
    return { linha, resto: pontos % totalEtiquetagens };
  });
  const faltam = 100 - linhas.reduce((soma, linha) => soma + linha.fatia, 0);
  restos.sort((a, b) => b.resto - a.resto);
  for (const { linha } of restos.slice(0, faltam)) {
    linha.fatia += 1;
  }

  // Volume primeiro: a pergunta é "qual assunto ocupou mais", e a leitura que
  // começa em cima não pode obrigar a varrer a lista para achar o maior.
  linhas.sort((a, b) => b.conversas - a.conversas || a.etiqueta.localeCompare(b.etiqueta, "pt-BR"));

  return ok(montarResposta(janela, tz, linhas, null, truncado), { requestId });
}

interface Conta {
  conversas: number;
  abertas: number;
  resolvidas: number;
  somaEsperaMs: number;
  medidas: number;
}

function zerada(): Conta {
  return { conversas: 0, abertas: 0, resolvidas: 0, somaEsperaMs: 0, medidas: 0 };
}

/**
 * Uma conversa de duas etiquetas conta em DUAS linhas: a pergunta é "deste
 * assunto, quantas", e suprimir a segunda mentiria o volume dela para beneficiar
 * o total. É por isso que o denominador de `fatia` é a soma das linhas.
 */
function agregar(conversas: ConversaBruta[], agora: number): Map<string, Conta> {
  const mapa = new Map<string, Conta>();
  for (const conversa of conversas) {
    const espera = esperaMs(conversa, agora);
    const encerrada = STATUS_ENCERRADOS.has(conversa.status);
    for (const etiqueta of conversa.tags ?? []) {
      if (!etiqueta) continue;
      const conta = mapa.get(etiqueta) ?? zerada();
      conta.conversas += 1;
      if (encerrada) conta.resolvidas += 1;
      else conta.abertas += 1;
      if (espera !== null) {
        conta.somaEsperaMs += espera;
        conta.medidas += 1;
      }
      mapa.set(etiqueta, conta);
    }
  }
  return mapa;
}

/**
 * De `awaiting_since` até `last_outbound_at` quando respondemos depois dela.
 * Sem resposta depois: aberta conta até `agora`; ENCERRADA termina em
 * `service_closed_at` — ou `null` sem ele, nunca `agora`, que faria um período
 * passado mudar a cada recarga. Sem `awaiting_since` não há régua — `null`, não
 * zero. O que `awaiting_since` significa em cada caso está no cabeçalho.
 */
function esperaMs(conversa: ConversaBruta, agora: number): number | null {
  const inicio = instante(conversa.awaiting_since);
  if (inicio === null) return null;
  const fim = instante(conversa.last_outbound_at);
  if (fim !== null && fim >= inicio) return fim - inicio;
  if (!STATUS_ENCERRADOS.has(conversa.status)) return Math.max(0, agora - inicio);
  const encerrada = instante(conversa.service_closed_at);
  return encerrada !== null && encerrada >= inicio ? encerrada - inicio : null;
}

function instante(texto: string | null): number | null {
  if (!texto) return null;
  const ms = Date.parse(texto);
  return Number.isNaN(ms) ? null : ms;
}

function montarResposta(
  janela: { de: string; ate: string },
  tz: string,
  linhas: LinhaDeEtiqueta[],
  motivo: string | null,
  truncado: boolean,
) {
  return {
    // A régua junto do número: período e fuso saem junto da conta, porque
    // número sem denominador declarado não muda decisão (03-medida-do-proposito).
    janela: { ...janela, tz },
    linhas,
    total_etiquetagens: linhas.reduce((soma, l) => soma + l.conversas, 0),
    sem_dados: linhas.length === 0,
    motivo,
    truncado,
  };
}

function etiquetasPedidas(brutas: string | undefined): string[] {
  const vistas = new Set<string>();
  for (const pedida of (brutas ?? "").split(",")) {
    const etiqueta = pedida.trim();
    if (etiqueta) vistas.add(etiqueta);
  }
  return [...vistas];
}

/** Dias de calendário cobertos pela janela, contando os dois extremos. */
function diasDeJanela(de: string, ate: string): number {
  const ms = Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}
