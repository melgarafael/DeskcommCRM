/**
 * MAPA DE ÁREAS DAS PORTAS DE TOKEN (Spec 33, F3, tarefa 2).
 *
 * Para um token de MÓDULO, cada porta (modelo de caminho + método) pertence a UMA área do
 * CRM e a um modo (leitura ou escrita), ou a NENHUMA. Sem área, o módulo é recusado: é o
 * lado seguro. Este arquivo é autônomo: recebe o modelo de porta como texto
 * (`/api/v1/pipelines/[id]/stages`, o mesmo formato das listas da fase R) e não importa
 * essas listas, que vivem em outra branch. A varredura "toda porta tem área ou está na lista
 * sem área" está em `areas.test.ts`.
 *
 * Regras, em ordem:
 *  1. Método fora de GET/HEAD/POST/PUT/PATCH/DELETE ⇒ null.
 *  2. A lista SEM área tem PRECEDÊNCIA sobre o mapa (rota que casa nas duas é sem área).
 *  3. Entre as entradas do mapa que casam, vence o prefixo MAIS LONGO. Na ESCRITA, as entradas de
 *     `MAPA_DE_ESCRITA` são consultadas ANTES: elas existem para a porta cuja leitura fica numa área
 *     e cuja escrita fica noutra (`financeiro/lancamentos`: lê em `analise`, escreve em `financeiro`).
 *  4. Nenhum prefixo casou ⇒ null (modelo desconhecido recusa).
 *
 * Casamento por SEGMENTO, nunca por texto solto: `contacts` casa `contacts/[id]` mas não
 * `contact-tags`. `[x]` num padrão casa só segmento dinâmico (`[id]`) do modelo, nunca um literal irmão.
 */
import type { ExtensionArea } from "@/lib/extensions/areas";

export type ModoDaPorta = "leitura" | "escrita";
export interface AreaDaPorta {
  area: ExtensionArea;
  modo: ModoDaPorta;
}

type Metodo = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
const LEITURA: readonly string[] = ["GET", "HEAD"];
const ESCRITA: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** Quais métodos a entrada recusa: todos, só os de escrita, ou um método nomeado. */
type Metodos = "todos" | "escrita" | Metodo;

interface EntradaSemArea {
  /** Caminho sem `/api/v1/`, com `[x]` onde há segmento dinâmico. */
  readonly modelo: string;
  readonly metodos: Metodos;
  /** Verdadeiro: casa só o caminho exato. Falso: também tudo que vem abaixo dele. */
  readonly exato?: boolean;
}

const e = (modelo: string, metodos: Metodos = "todos", exato = false): EntradaSemArea => ({
  modelo,
  metodos,
  exato,
});

/**
 * A lista "NUNCA HÁ ÁREA". Cada grupo tem o motivo.
 */
const SEM_AREA: readonly EntradaSemArea[] = [
  // --- 1. Credencial, token, acesso, cobrança: dão ou tiram poder (spec 33, "Nunca há área").
  e("settings/api-tokens"), // tokens de API: um módulo não emite credencial
  e("settings/assinatura"), // cobrança
  e("settings/art15"), // LGPD (acesso do titular)
  e("team/invite"), // convite: dá acesso a pessoas
  e("team/invites"),
  e("team/[id]/role"), // papel: dá e tira poder
  e("team/[id]/revoke"), // tira acesso
  e("team/[id]/reactivate"),
  e("team/[id]/interface"),
  e("team/[id]", "todos", true), // ficha da pessoa da equipe (e-mail de login)
  e("team", "escrita"), // toda escrita em equipe; só `team/assignable` GET tem área
  e("ai/providers"), // provedor e chave de IA
  e("ai/credentials"),
  e("ai/knowledge/chave"),
  e("ai/knowledge/provedor"),
  e("voip"), // tronco de voz (credencial)
  e("external-db"), // credencial de banco externo
  e("channels"), // conexão de canal e credencial do provedor
  e("channel-sessions"), // conexão, pareamento e QR do canal
  e("agenda/google"), // conexão com a conta Google
  e("modulos"), // administração de extensões (inclui o objeto de dados do módulo)
  e("extensions"),
  e("admin"),
  e("cron"),
  e("webhooks"),
  e("mcp"),
  e("auth"),

  // --- 2. Envio ao cliente e disparo (D6: quem envia é a pessoa).
  e("messages", "todos", true), // envia mensagem
  e("messages/[id]", "todos", true),
  e("messages/[id]/forward"),
  e("messages/[id]/retry"),
  e("campaigns"), // inicia disparo em lote
  e("automation-rules/runs/[id]/resend"),
  e("ai/replies"),
  e("ai/cases/[id]/reply"),
  e("proposals/[id]/send"),
  e("agenda/agendamentos/[id]/google/meet"), // deliver, resend, retry: enviam ao cliente
  e("ai/cases/alerta"), // aviso por WhatsApp (e o teste)
  e("agenda/aviso"),
  e("ai/followups/enrollments", "POST", true), // agenda envio a um contato
  e("ai/followups/enrollments/[id]/resume"),
  e("ai/followups/enrollments/[id]/skip"),
  e("contacts/[id]/unblock"), // desfaz o descadastro, que é regra do envio
  e("voice"), // chamada de voz em tempo real
  e("leads/[id]/conversion"), // reenvia conversão à plataforma de anúncio
  e("conversions"),
  e("ai/followup-flows/[id]/publish"), // publicar e reverter seguem só na tela (#1875)
  e("ai/followup-flows/[id]/rollback"),

  // --- 3. LGPD e exportação de dado pessoal.
  e("lgpd"),
  e("contacts/[id]", "DELETE", true), // exclusão de contato
  e("contacts/bulk", "DELETE", true), // exclusão em lote, mesmo efeito de apagar contato
  e("contacts/export"),
  e("conversations/[id]/export"),
  e("audit/export"),

  // --- 4. Só de sessão por desenho: o sujeito é a própria pessoa logada.
  e("attendants/presence"),
  e("notifications"),
  e("conversations/[id]/claim"),
  e("conversations/[id]/release"),
  e("conversations/[id]/mark-read"),
  e("conversations/[id]/aviso-de-mensagem"),
  e("conversations/[id]/draft-reply"), // não classificado na R; fecha por cautela
  e("prospecting"),

  // --- 5. Financeiro e honorários: dinheiro que não se desfaz. O resto do financeiro tem a área
  //        `financeiro` (ver MAPA e MAPA_DE_ESCRITA); estas quatro ficam de fora porque mexem com
  //        dinheiro, não se desfazem e hoje nem aceitam token de integração (decisão de 10/11).
  e("financeiro/comandas/[id]/finalizar"), // fecha a comanda e gera o recebimento
  e("financeiro/comandas/[id]/estornar"), // devolve dinheiro
  e("financeiro/comandas/faturar-lote"), // fatura várias comandas de uma vez
  e("honorarios/parcelas/[id]/pagar"), // dá baixa numa parcela de honorário

  // --- 5b. Escritas que gastam dinheiro da organização ou não se desfazem: lado seguro (decisão
  //         do engenheiro, 05/11). Afrouxar depois é fácil; apertar depois de um módulo usar, não.
  e("ai/budget", "escrita"), // teto de gasto de IA
  e("ai/voz", "escrita"), // custo de voz
  e("ai/knowledge/reindex-all", "escrita"), // reindexação inteira gasta IA
  e("contacts/merge", "escrita"), // fusão de contatos não se desfaz

  // --- 6. Leitura-apenas por decisão do mapa: regras de automação só têm área na leitura.
  e("automation-rules", "escrita"),

  // --- 7. Só LEITURA tem área: a escrita mexe com o cliente ou com a conexão do canal.
  e("calls", "escrita"), // ligar para o cliente é falar com o cliente (D6); só a leitura do histórico tem área
  e("channel-schedules", "escrita"), // a janela pausa canais do WhatsApp; desfazer exige a pausa manual em Conexões
  e("ads", "escrita"), // leitura das contas e campanhas tem área; escrita não
  e("messages/[id]/media", "escrita"), // só a leitura do arquivo tem área

  // --- 8. Sem área por decisão, com o motivo escrito (10/11/2026). Afrouxar depois é fácil;
  //        apertar depois de um módulo usar, não.
  e("campaign-suppressions"), // tirar alguém da lista faz a campanha voltar a escrever para quem pediu para parar
  e("audit"), // a auditoria mostra tudo de todos
  e("imports"), // entrada de contatos em massa, não se desfaz
  e("phone-numbers"), // a leitura só aceita sessão (`requireRole`); a escrita mexe na conexão do canal
];

/**
 * Modelos/prefixos que NUNCA têm área em NENHUM método (o que não depende do método).
 */
export const PORTAS_SEM_AREA_POR_DESENHO: readonly string[] = SEM_AREA.filter(
  (x) => x.metodos === "todos",
).map((x) => x.modelo);

/** Prefixos cuja ESCRITA nunca tem área (a leitura pode ter, pelo mapa). */
export const PORTAS_SEM_AREA_NA_ESCRITA: readonly string[] = SEM_AREA.filter(
  (x) => x.metodos === "escrita",
).map((x) => x.modelo);

/** Prefixo do modelo → área. A leitura e a escrita saem do método. */
const MAPA: readonly (readonly [string, ExtensionArea])[] = [
  // contatos
  ["contacts", "contatos"],
  ["people", "contatos"],
  ["company-people", "contatos"],
  ["tags", "contatos"],
  ["companies", "contatos"],
  ["segments", "contatos"],
  // negocios. `pipelines/[id]/leads` e `board` devolvem LEADS: ficam em negocios (prefixo
  // mais longo vence `pipelines`), senão uma área de funis leria negócios.
  ["leads", "negocios"],
  ["deals", "negocios"],
  ["proposals", "negocios"],
  ["lead-captures", "negocios"],
  ["forecast", "negocios"],
  ["pipelines/[id]/leads", "negocios"],
  ["pipelines/[id]/board", "negocios"],
  // conversas (envio fica de fora: ver SEM_AREA)
  ["conversations", "conversas"],
  ["messages/[id]/hide", "conversas"],
  ["messages/[id]/media", "conversas"], // só leitura (a escrita está em SEM_AREA)
  ["calls", "conversas"], // só leitura (a escrita está em SEM_AREA)
  ["notes", "conversas"],
  ["handoffs", "conversas"],
  // agenda
  ["agenda", "agenda"],
  ["appointments", "agenda"],
  // funis. `pipelines/[id]/forecast` é funis: o plano põe "previsão" em funis, e o prefixo
  // `forecast` do plano é o da raiz, não este.
  ["pipelines", "funis"],
  ["automation-rules", "funis"],
  // agentes_ia
  ["ai", "agentes_ia"],
  // catalogo
  ["products", "catalogo"],
  ["services", "catalogo"],
  ["catalogo", "catalogo"],
  ["message-templates", "catalogo"],
  ["financeiro/catalogo", "catalogo"],
  // configuracao. `attendants/sectors` é setor de atendimento (configuração), não agenda.
  ["settings", "configuracao"],
  ["attendants/availability", "configuracao"],
  ["attendants/sector", "configuracao"],
  ["attendants/sectors", "configuracao"],
  ["team/assignable", "configuracao"],
  ["routing", "configuracao"],
  // O modelo de campanha não envia nada sozinho: quem dispara a campanha é a pessoa.
  ["campaign-templates", "configuracao"],
  ["message-template-groups", "configuracao"],
  ["channel-schedules", "configuracao"],
  // analise
  ["metrics", "analise"],
  ["reports", "analise"],
  ["financeiro/lancamentos", "analise"],
  ["honorarios", "analise"],
  ["ads/meta/accounts", "analise"], // só leitura (a escrita está em SEM_AREA)
  ["ads/meta/campaigns", "analise"],
  // tarefas
  ["tasks", "tarefas"],
  ["demandas", "tarefas"],
  // etiquetas (não há área própria: não existe rota de escrita de etiqueta)
  ["contact-tags", "contatos"], // só leitura hoje
  ["conversation-tags", "conversas"], // só leitura hoje
  // financeiro: comandas e fidelidade têm a área nos dois modos. As quatro portas de dinheiro que
  // não se desfazem estão em SEM_AREA e vencem. O que não casa aqui, nem no mapa de escrita, recusa.
  ["financeiro/comandas", "financeiro"],
  ["financeiro/fidelidade", "financeiro"],
];

/**
 * Entradas que valem SÓ para escrita, consultadas antes de `MAPA`. A leitura destas portas fica na
 * área do mapa acima (catálogo, análise); a escrita é de `financeiro`.
 */
const MAPA_DE_ESCRITA: readonly (readonly [string, ExtensionArea])[] = [
  ["financeiro/catalogo", "financeiro"],
  ["financeiro/lancamentos", "financeiro"],
  ["honorarios", "financeiro"],
];

function segmentos(modelo: string): string[] | null {
  const m = /^\/api\/v1\/(.+?)\/?$/.exec(modelo.trim());
  if (!m) return null;
  return (m[1] ?? "").split("/").filter((s) => s.length > 0);
}

function ehParametro(segmento: string): boolean {
  return /^\[[^\]]+\]$/.test(segmento);
}

function casa(padrao: string, partes: string[], exato: boolean): boolean {
  const ps = padrao.split("/");
  if (partes.length < ps.length) return false;
  if (exato && partes.length !== ps.length) return false;
  // `[x]` do padrão só casa segmento dinâmico do modelo: `team/[id]` NÃO casa `team/assignable`.
  return ps.every((p, i) => (ehParametro(p) ? ehParametro(partes[i] ?? "") : p === partes[i]));
}

function metodoNormalizado(metodo: string): string {
  return metodo.trim().toUpperCase();
}

/** Verdadeiro quando a lista sem área recusa este modelo neste método. */
export function estaSemAreaPorDesenho(modelo: string, metodo: string): boolean {
  const partes = segmentos(modelo);
  if (!partes) return true;
  const m = metodoNormalizado(metodo);
  return SEM_AREA.some((x) => {
    if (!casa(x.modelo, partes, x.exato === true)) return false;
    if (x.metodos === "todos") return true;
    if (x.metodos === "escrita") return ESCRITA.includes(m);
    return x.metodos === m;
  });
}

/**
 * Leituras que trazem o CONTATO (nome, telefone) dentro da resposta e que NÃO passam pelo redator
 * (`lib/modulo/redigir-contato.ts`). Para módulo, estas portas exigem TAMBÉM a área `contatos` em
 * leitura: o consentimento por área vale para o dado e não só para a rota (ADR-0005 D4). Conversas e
 * o quadro de negócios não entram aqui: o redator tira o contato e eles seguem com a própria área.
 * Lado seguro: rota nova que embute contato entra nesta lista ou passa pelo redator; a cerca
 * `tests/unit/modulo-rota-com-contato-redige.test.ts` cobra uma das duas.
 */
const LEITURAS_COM_CONTATO_EMBUTIDO: readonly string[] = [
  "agenda/agendamentos",
  "agenda/vinculos",
  "ai/followups/queue",
  "ai/followups/enrollments/[id]",
  "ai/cases/[id]/chat",
  "leads/[id]/contatos-relacionados",
  "leads/proposals",
  "proposals/[id]/documento",
  "financeiro/fidelidade", // saldo e extrato de pontos de UM contato
  "calls", // o histórico de chamadas traz o contato que foi chamado
  "messages/[id]/media", // o arquivo é da conversa com o cliente
  "financeiro/comandas/pendentes", // traz o `title` do agendamento, que pode ter o nome do cliente
];

export function leituraExigeAreaContatos(modelo: string, metodo: string): boolean {
  if (!LEITURA.includes(metodoNormalizado(metodo))) return false;
  const partes = segmentos(modelo);
  if (!partes) return false;
  return LEITURAS_COM_CONTATO_EMBUTIDO.some((p) => casa(p, partes, false));
}

export function areaDaPorta(modelo: string, metodo: string): AreaDaPorta | null {
  const m = metodoNormalizado(metodo);
  const modo: ModoDaPorta | null = LEITURA.includes(m)
    ? "leitura"
    : ESCRITA.includes(m)
      ? "escrita"
      : null;
  if (!modo) return null;

  const partes = segmentos(modelo);
  if (!partes) return null;
  if (estaSemAreaPorDesenho(modelo, m)) return null;

  // Na escrita, o mapa próprio dela vem primeiro; sem entrada ali, vale o mapa geral.
  const mapas = modo === "escrita" ? [MAPA_DE_ESCRITA, MAPA] : [MAPA];
  for (const mapa of mapas) {
    let melhor: { area: ExtensionArea; tamanho: number } | null = null;
    for (const [prefixo, area] of mapa) {
      if (!casa(prefixo, partes, false)) continue;
      const tamanho = prefixo.split("/").length;
      if (!melhor || tamanho > melhor.tamanho) melhor = { area, tamanho };
    }
    if (melhor) return { area: melhor.area, modo };
  }
  return null;
}

/**
 * Todo segmento LITERAL (não `[x]`) que aparece em algum padrão do mapa ou da lista sem área.
 * Quem recebe um caminho REAL (`autorizarModulo`) usa isto para separar "palavra da rota" de
 * "valor dinâmico" quando o valor não é um UUID. Segmento que não está aqui vira `[id]`.
 */
export const SEGMENTOS_LITERAIS_CONHECIDOS: ReadonlySet<string> = new Set(
  [
    ...SEM_AREA.map((x) => x.modelo),
    ...MAPA.map(([prefixo]) => prefixo),
    ...MAPA_DE_ESCRITA.map(([prefixo]) => prefixo),
    // Sem isto `agenda/vinculos` viraria `agenda/[id]` e a trava de contato nunca casaria.
    ...LEITURAS_COM_CONTATO_EMBUTIDO,
  ]
    .flatMap((modelo) => modelo.split("/"))
    .filter((s) => !ehParametro(s)),
);

/** Só para o teste de consistência: o mapa cru, sem a lista sem área. */
export const PREFIXOS_DO_MAPA: readonly (readonly [string, ExtensionArea])[] = MAPA;

/** Só para o teste de consistência: o mapa que vale só na escrita. */
export const PREFIXOS_DO_MAPA_DE_ESCRITA: readonly (readonly [string, ExtensionArea])[] =
  MAPA_DE_ESCRITA;
