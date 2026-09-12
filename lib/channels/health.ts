/**
 * A conexão caiu — e alguém precisa SABER.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A sessão do canal saiu de `WORKING` às 13:19. O estado foi gravado na coluna,
 * o operador não recebeu nada, e a descoberta aconteceu horas depois, quando ele
 * foi olhar por conta própria — depois de estranhar que ninguém escrevia. Não
 * havia bug em lugar nenhum: o webhook chegou, a coluna atualizou. O que faltava
 * era a única parte que importa para quem atende — o aviso.
 *
 * ─── Por que este arquivo existe, se o mecanismo já estava desenhado ────────
 *
 * Estava: `channel_session_health.escalated_status` nasceu com o comentário
 * "Status já escalado (agent_inbox_items kind='qr_rescan') no EPISÓDIO corrente
 * — dedup do 'exatamente 1×'. Volta a null quando a sessão volta a WORKING", e
 * `SESSION_ESCALATION_STATUSES` foi declarada em `edge/crm/session-watchdog.ts`.
 * A coluna, a constante e o kind existiam; o código que escala nunca foi
 * escrito. `git grep` achava os três e nenhum consumidor — promessa de esqueleto,
 * sem músculo. Este arquivo é o músculo, e usa a peça desenhada em vez de
 * inventar uma paralela.
 *
 * ─── Dois gatilhos, porque falham de formas diferentes ─────────────────────
 *
 * O webhook de status avisa em segundos — e emudece justamente quando o
 * transporte morre, que é o pior caso. O vigia PERGUNTA, e por isso enxerga o
 * silêncio. Um sem o outro deixa um buraco: só webhook não vê o transporte
 * morto; só vigia demora até a próxima rodada. Os dois chamam esta mesma
 * função, então a regra de quando avisar existe uma vez só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVIDERS_DE_MENSAGEM } from "./capabilities";

/** Único estado em que mensagem entra e sai. Contrato do CRM (uppercase). */
export const STATUS_SAUDAVEL = "WORKING";

/**
 * Estados que merecem aviso.
 *
 * `SCAN_QR_CODE` e `FAILED` vêm de `SESSION_ESCALATION_STATUSES`, declarada
 * quando o mecanismo foi desenhado. `STOPPED` foi ACRESCENTADO aqui: para quem
 * atende, uma sessão parada é indistinguível de uma quebrada — em ambos os casos
 * ninguém recebe mensagem, que é a única coisa que o operador sente. Parar de
 * propósito e não ser avisado é um incômodo pequeno; não ser avisado de uma
 * parada que ninguém pediu é o defeito que motivou este arquivo.
 *
 * `STARTING` NÃO entra: é o estado normal de todo boot, e avisar nele faria o
 * sistema gritar a cada reinício — o caminho mais curto para o operador aprender
 * a ignorar o aviso.
 */
export const STATUS_QUE_AVISAM = ["SCAN_QR_CODE", "FAILED", "STOPPED"] as const;

/** Marca os avisos desta origem, para resolver o do canal CERTO depois. */
export const REF_KIND_SESSAO = "channel_session";

/**
 * O transporte respondeu, e a resposta foi "sua credencial não vale".
 *
 * Vive aqui, e não no adapter, porque quem lê este código é a regra de aviso
 * logo abaixo: é um contrato entre os dois, e um literal repetido nas duas
 * pontas divergiria no primeiro renomeio — com o gate verde, porque nenhum
 * `includes` reclama de string que ninguém mais escreve.
 */
export const DETALHE_CREDENCIAL_RECUSADA = "credencial_recusada_pelo_transporte";

/**
 * Marca do episódio aberto por um EMPURRÃO do provedor.
 *
 * A varredura não fecha episódio com esta marca: ela mede credencial e conta,
 * não o estado do número, e um número suspenso continua aparecendo na lista de
 * contas. Sem a marca, o crítico de suspensão sumia da Central em ≤5 minutos.
 */
export const PREFIXO_EMPURRAO = "PUSH:";

export interface AvisoDeConexao {
  kind: "qr_rescan" | "channel_number_alert";
  severity: "warn" | "critical";
  title: string;
  body: string | null;
  /** O que grava em `escalated_status` — o episódio já escalado. */
  episodio: string;
}

export interface SaudeObservada {
  reachable: boolean;
  status: string | null;
  detail: string | null;
}

/**
 * O que foi observado merece aviso? `null` quando está tudo bem.
 *
 * `apelido` é como o operador chama esta conexão na tela. Entra no título porque
 * com dois números ligados "WhatsApp desconectado" não diz QUAL — e a primeira
 * pergunta de quem lê o aviso é exatamente essa.
 */
export function avisoDaConexao(saude: SaudeObservada, apelido: string): AvisoDeConexao | null {
  if (!saude.reachable) {
    // "Não deu para perguntar" tem DOIS motivos que pedem ações opostas, e
    // tratá-los igual foi o defeito medido: numa VPS real a chave do WAHA foi
    // trocada por uma segunda cópia do repo, TUDO parou, e por três dias a
    // Central mostrou apenas um `warn` dizendo "não foi possível verificar" —
    // a frase que se usa para descrever um soluço de rede. O dono só descobriu
    // ao tentar conectar um número e ver o 401 na cara.
    //
    // Quando o transporte RESPONDE recusando a credencial, não há incerteza
    // sobre a causa nem sobre o que fazer — e escanear o QR, que é o reflexo de
    // quem lê "conexão caída", não resolve nada.
    if (saude.detail === DETALHE_CREDENCIAL_RECUSADA) {
      return {
        kind: "channel_number_alert",
        severity: "critical",
        title: `Conexão "${apelido}": o servidor de WhatsApp recusou a chave de acesso`,
        body:
          "Escanear o QR não resolve: a chave que o CRM usa para falar com o servidor de WhatsApp não confere com a que o servidor espera. Enquanto isso durar, nenhuma mensagem entra nem sai por NENHUMA conexão. Quem cuida do servidor precisa conferir a WAHA_API_KEY do .env e recriar o contêiner do WhatsApp.",
        episodio: "CREDENCIAL_RECUSADA",
      };
    }

    // Não deu para perguntar mesmo. NÃO é o mesmo que estar caído, e o aviso
    // não pode afirmar o que não sabe: a ação aqui é olhar o serviço, não
    // escanear um QR. `warn` e não `critical` porque uma oscilação de rede cabe
    // neste ramo, e gritar por ela ensinaria o operador a ignorar a cor.
    return {
      kind: "channel_number_alert",
      severity: "warn",
      title: `Não foi possível verificar a conexão "${apelido}"`,
      body: saude.detail,
      episodio: "UNREACHABLE",
    };
  }

  const status = (saude.status ?? "").toUpperCase();
  if (!status || status === STATUS_SAUDAVEL) return null;
  if (!(STATUS_QUE_AVISAM as readonly string[]).includes(status)) return null;

  if (status === "SCAN_QR_CODE") {
    return {
      kind: "qr_rescan",
      severity: "critical",
      title: `WhatsApp "${apelido}" desconectado — precisa escanear o QR de novo`,
      body: "Enquanto isso não acontecer, nenhuma mensagem entra nem sai por esta conexão.",
      episodio: status,
    };
  }

  return {
    kind: "channel_number_alert",
    severity: "critical",
    title: `WhatsApp "${apelido}" fora do ar (${status})`,
    body: "Nenhuma mensagem entra nem sai por esta conexão até ela voltar.",
    episodio: status,
  };
}

/** O que a faixa do topo mostra: conexão caída, com nome. */
export interface ConexaoCaida {
  id: string;
  apelido: string;
  status: string;
}

/**
 * As conexões desta organização que estão fora do ar AGORA.
 *
 * Mora aqui, e não na tela, por duas razões que o repo já pagou caro: telas que
 * montam a consulta de `channel_sessions` à mão foram o que deixou três
 * seletores oferecendo canal arquivado (vigiado por `canais-selecionaveis`); e o
 * filtro de estados precisa ser LITERALMENTE o mesmo que decide o aviso — uma
 * segunda lista divergiria com o tempo, e a faixa deixaria de aparecer para um
 * estado que a Central considera grave.
 *
 * Arquivada fica de fora: foi desligada de propósito, e anunciar que uma conexão
 * aposentada está parada é o ruído que ensina a ignorar a faixa.
 */
export async function listarConexoesCaidas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ConexaoCaida[]> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, display_name, phone_number, status")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    // A faixa diz "nenhuma mensagem entra nem sai por esta conexão" e leva a
    // Conexões. A linha de chamada de voz (spec 18) não é vigiada pelo cron de
    // saúde (nenhum adapter a consulta), então o `status` dela envelhece parado:
    // anunciá-la aqui seria a faixa permanente que ensina a ignorar a faixa.
    .in("provider", [...PROVIDERS_DE_MENSAGEM])
    .in("status", [...STATUS_QUE_AVISAM]);

  return (data ?? []).map((s) => ({
    id: s.id as string,
    apelido: (s.display_name as string | null) ?? (s.phone_number as string | null) ?? "sem nome",
    status: (s.status as string | null) ?? "",
  }));
}

interface SessaoParaVigiar {
  id: string;
  organization_id: string;
  status: string | null;
}

/**
 * Escala uma vez por episódio e RESOLVE quando volta.
 *
 * O "uma vez" mora em `escalated_status`: sem ele, um vigia de 5 em 5 minutos
 * abriria doze avisos por hora do mesmo problema, e a Central viraria uma lista
 * do mesmo aviso — que é a forma mais rápida de tornar a Central inútil.
 *
 * Resolver na volta é a outra metade, e a menos óbvia: aviso que não fecha
 * sozinho ensina que a Central mostra coisa velha, e aí o operador para de
 * confiar no que está aberto. Só fecha os avisos DESTA sessão (`ref_id`) —
 * fechar por organização apagaria o alerta de um outro canal que segue caído.
 */
export async function sincronizarSaudeDaConexao(
  admin: SupabaseClient,
  sessao: SessaoParaVigiar,
  saude: SaudeObservada,
  apelido: string,
  /**
   * QUEM observou — e é o que decide se esta observação pode FECHAR o aviso.
   *
   * ─── O defeito que isto existe para impedir ───────────────────────────────
   *
   * As duas fontes medem coisas DIFERENTES:
   *
   *   - o empurrão do provedor fala do NÚMERO ("suspenso", "desconectado");
   *   - a varredura fala da CREDENCIAL e da conta ("a chave responde, a conta
   *     está na lista").
   *
   * Um número suspenso continua aparecendo na lista de contas. Então a
   * varredura via `WORKING`, `avisoDaConexao` devolvia `null`, e o ramo de
   * baixo marcava como resolvido o crítico que o empurrão tinha aberto minutos
   * antes — com o número ainda suspenso. O aviso sumia da Central em ≤5 min e
   * o provedor não reenvia o evento, então ninguém ficava sabendo.
   *
   * Trocar "aviso que nunca fecha" por "aviso que fecha sozinho sem o problema
   * ter acabado" é o pior dos dois, porque o segundo parece que funciona.
   *
   * Regra: só fecha quem sabe do que está falando. O empurrão fecha qualquer
   * episódio (ele é a autoridade sobre o número); a varredura fecha só o que
   * ela mesma poderia ter aberto.
   */
  origem: "varredura" | "empurrao" = "varredura",
): Promise<"avisado" | "ja_avisado" | "resolvido" | "sem_mudanca"> {
  const aviso = avisoDaConexao(saude, apelido);

  const { data: linha } = await admin
    .from("channel_session_health")
    .select("escalated_status")
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .maybeSingle();
  const jaEscalado = (linha?.escalated_status as string | null) ?? null;

  if (!aviso) {
    if (!jaEscalado) return "sem_mudanca";
    // O episódio veio do provedor e quem está observando é a varredura: ela não
    // tem como saber se o número deixou de estar suspenso. Não fecha.
    if (origem === "varredura" && jaEscalado.startsWith(PREFIXO_EMPURRAO)) {
      return "sem_mudanca";
    }
    await admin
      .from("agent_inbox_items")
      .update({ status: "resolved" })
      .eq("organization_id", sessao.organization_id)
      .eq("ref_kind", REF_KIND_SESSAO)
      .eq("ref_id", sessao.id)
      .eq("status", "open");
    await gravarEpisodio(admin, sessao, null);
    return "resolvido";
  }

  // O episódio carrega QUEM o observou. Sem isso, a varredura não teria como
  // saber que aquele crítico veio do provedor — e voltaria a fechá-lo.
  const episodio =
    origem === "empurrao" ? `${PREFIXO_EMPURRAO}${aviso.episodio}` : aviso.episodio;

  // Mesmo episódio: já foi avisado, e repetir é ruído. Um episódio DIFERENTE
  // (caiu por QR, agora está FAILED) avisa de novo — mudou o que fazer.
  if (jaEscalado === episodio) return "ja_avisado";

  await admin.from("agent_inbox_items").insert({
    organization_id: sessao.organization_id,
    kind: aviso.kind,
    severity: aviso.severity,
    title: aviso.title,
    body: aviso.body,
    ref_kind: REF_KIND_SESSAO,
    ref_id: sessao.id,
  });
  await gravarEpisodio(admin, sessao, episodio);
  return "avisado";
}

/**
 * A linha de saúde pode não existir ainda — `upsert` pelo par único, e não
 * `update`, porque um `update` que não acha linha não escreve nada e o dedup
 * silenciosamente pararia de funcionar: avisaria de novo a cada rodada.
 */
async function gravarEpisodio(
  admin: SupabaseClient,
  sessao: SessaoParaVigiar,
  episodio: string | null,
): Promise<void> {
  await admin.from("channel_session_health").upsert(
    {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      status: sessao.status ?? "UNKNOWN",
      escalated_status: episodio,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,channel_session_id" },
  );
}
