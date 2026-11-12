/**
 * QUAIS ferramentas de ESCRITA de um servidor MCP externo podem rodar durante o
 * atendimento (#4445) — lista EXPLÍCITA, por organização e por conexão.
 *
 * ── Por que a liberação é uma lista, e não uma chave ────────────────────────
 *
 * O servidor externo é sistema de terceiro: uma ferramenta marcada `escrita`
 * pode cancelar uma reserva, faturar um pedido, apagar um cadastro. "Ligar a
 * escrita" numa chave booleana entregaria ao modelo TODA ferramenta que o ERP
 * anuncia hoje — e toda ferramenta que ele passar a anunciar amanhã, sem
 * ninguém decidir. Por isso quem libera nomeia ferramenta por ferramenta.
 *
 * ── Por que o CURIGA é recusado em vez de expandido ─────────────────────────
 *
 * `*`, `all`, `todos` e qualquer nome com `*` ou `?` parecem atalho de
 * configuração e são, na prática, a chave booleana escrita de outro jeito: o
 * administrador digita uma vez e o conjunto passa a crescer sozinho com o
 * catálogo do terceiro. Aqui eles NÃO são expandidos nem guardados: caem fora
 * da leitura, e a ferramenta que eles pretendiam liberar continua recusada
 * (`escrita_nao_liberada`). O silêncio é de propósito — a alternativa seria
 * guardar um curinga "inválido" que a próxima leitura pudesse interpretar.
 *
 * ── Onde mora (e por que não há migration) ──────────────────────────────────
 *
 * `organizations.settings.mcp_externo_escrita`, o mesmo jsonb que já guarda o
 * endereço do servidor compartilhado:
 *
 *   {
 *     "organizacao": ["cancelar_reserva"],            // vale para toda conexão
 *     "conexoes": { "<id-do-servidor>": ["agendar"] } // por conexão
 *   }
 *
 * A conexão do servidor COMPARTILHADO da organização é `compartilhado`
 * (`CONEXAO_COMPARTILHADA`); a de um servidor do agente é o id dele em
 * `ai_agent_mcp_servers` — nomes iguais em conexões diferentes são liberações
 * diferentes, do mesmo jeito que a escolha em `tool_ids` (ver `ids.ts`).
 *
 * A leitura NUNCA lança: quem chama é o caminho quente do turno, e configuração
 * torta tem de significar "nada liberado", nunca "turno caído".
 */

/** O bolso de `organizations.settings` onde a liberação mora. */
export const BOLSO_ESCRITA_LIBERADA = "mcp_externo_escrita";

/** A conexão do servidor COMPARTILHADO da organização (`../carregar.ts`). */
export const CONEXAO_COMPARTILHADA = "compartilhado";

/** O código da recusa NOMEADA de uma escrita fora da lista (#4445). */
export const RECUSA_ESCRITA_NAO_LIBERADA = "escrita_nao_liberada";

/** A liberação como o turno a lê: os dois níveis, já sem nada inválido. */
export interface EscritaLiberada {
  /** Nomes liberados para QUALQUER conexão da organização. */
  readonly organizacao: readonly string[];
  /** Nomes liberados por conexão (`id do servidor` ou `compartilhado`). */
  readonly conexoes: Readonly<Record<string, readonly string[]>>;
}

/** A mesma régua do protocolo MCP (`ids.ts`): o nome que o servidor anuncia. */
const NOME_DE_PROTOCOLO = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * As palavras que significam "tudo" para quem escreve configuração à mão. Elas
 * não são nomes de ferramenta de nenhum servidor sério, e aceitá-las seria
 * abrir a lista inteira por engano de vocabulário.
 */
const PALAVRAS_DE_TUDO = new Set(["*", "all", "todos", "tudo", "qualquer", "any"]);

/**
 * `true` quando o texto é uma tentativa de curinga — inclusive `erp_*`, que
 * tenta liberar uma família inteira por prefixo.
 */
export function ehCuringaDeEscrita(nome: unknown): boolean {
  if (typeof nome !== "string") return false;
  const normalizado = nome.trim().toLowerCase();
  if (normalizado === "") return false;
  return PALAVRAS_DE_TUDO.has(normalizado) || /[*?]/.test(normalizado);
}

/**
 * Os nomes VÁLIDOS e EXPLÍCITOS de uma lista crua. Descarta, sem expandir e sem
 * guardar: curinga, nome fora do protocolo, vazio, repetido e o que não é texto.
 */
function nomesExplicitos(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<string>();
  for (const item of bruto) {
    if (typeof item !== "string") continue;
    const nome = item.trim();
    if (!NOME_DE_PROTOCOLO.test(nome)) continue;
    if (ehCuringaDeEscrita(nome)) continue;
    vistos.add(nome);
  }
  return [...vistos];
}

/**
 * A liberação registrada em `settings`, já filtrada. Bolso ausente, malformado
 * ou com curinga devolve listas vazias — e lista vazia é "nada liberado", que é
 * o estado em que a instalação nasce.
 */
export function lerEscritaLiberada(settings: unknown): EscritaLiberada {
  if (typeof settings !== "object" || settings === null) {
    return { organizacao: [], conexoes: {} };
  }
  const bruto = (settings as Record<string, unknown>)[BOLSO_ESCRITA_LIBERADA];
  if (typeof bruto !== "object" || bruto === null) {
    return { organizacao: [], conexoes: {} };
  }
  const { organizacao, conexoes } = bruto as Record<string, unknown>;
  const porConexao: Record<string, readonly string[]> = {};
  if (typeof conexoes === "object" && conexoes !== null && !Array.isArray(conexoes)) {
    for (const [conexao, lista] of Object.entries(conexoes as Record<string, unknown>)) {
      const nomes = nomesExplicitos(lista);
      // Conexão sem nenhum nome válido não vira entrada: `{ "x": ["*"] }` não
      // pode virar `{ "x": [] }`, senão o curinga deixa rastro de "configurado".
      if (nomes.length > 0) porConexao[conexao] = nomes;
    }
  }
  return { organizacao: nomesExplicitos(organizacao), conexoes: porConexao };
}

/**
 * Os nomes liberados para UMA conexão: a lista da organização MAIS a da
 * conexão. Duas listas explícitas, uma união — não há hierarquia escondida, e
 * tirar um nome de uma das duas continua tirando a liberação dele daquela
 * origem (para revogar de vez, o nome sai das duas).
 */
export function escritasLiberadasDaConexao(config: EscritaLiberada, conexao: string): string[] {
  const nomes = new Set(config.organizacao);
  for (const nome of config.conexoes[conexao] ?? []) nomes.add(nome);
  return [...nomes];
}

/** O teste que o turno faz: esta ferramenta, nesta conexão, está liberada? */
export function escritaLiberada(
  liberadas: readonly string[] | undefined,
  ferramenta: string,
): boolean {
  return (liberadas ?? []).includes(ferramenta);
}

/**
 * A recusa NOMEADA que o modelo recebe (#4445) — ferramenta, conexão e o que
 * fazer em vez de repetir.
 *
 * Ela existe porque a alternativa é o que o produto fazia antes: a escrita caía
 * na recusa genérica de escopo do turno (`escrita_sem_escopo_do_turno`), que
 * não diz que existe uma LISTA, não diz qual conexão, e ensina o modelo a
 * desistir da ação em vez de contornar do jeito certo (concluir o que dá e
 * passar à equipe o que depende de liberação).
 */
export function recusaDaEscritaNaoLiberada(
  ferramenta: string,
  conexao: string,
): { permitido: false; erro: string; motivo: string; mensagem: string } {
  return {
    permitido: false,
    erro: RECUSA_ESCRITA_NAO_LIBERADA,
    motivo: RECUSA_ESCRITA_NAO_LIBERADA,
    mensagem:
      `a ferramenta "${ferramenta}" não está liberada para escrita na conexão "${conexao}" desta ` +
      "empresa. Não repita a chamada: conclua pela conversa o que não depende dela e diga ao " +
      "cliente que a equipe termina esta ação.",
  };
}

/**
 * Grava a liberação no jsonb de `settings`, preservando os outros bolsos — o
 * mesmo merge em dois níveis de `mesclarServidorMcpExterno` (`registro.ts`).
 *
 * Lista vazia APAGA o bolso: `{ organizacao: [], conexoes: { x: [] } }` seria um
 * registro que a leitura enxerga como presente e não libera nada, e o operador
 * não teria como distinguir "não configurei" de "configurei e não pegou".
 */
export function mesclarEscritaLiberada(
  settings: unknown,
  entrada: { organizacao?: readonly string[]; conexoes?: Readonly<Record<string, readonly string[]>> },
): Record<string, unknown> {
  const atual: Record<string, unknown> =
    typeof settings === "object" && settings !== null
      ? { ...(settings as Record<string, unknown>) }
      : {};

  const organizacao = nomesExplicitos(entrada.organizacao ?? []);
  const conexoes: Record<string, readonly string[]> = {};
  for (const [conexao, lista] of Object.entries(entrada.conexoes ?? {})) {
    const nomes = nomesExplicitos(lista);
    if (conexao.trim() !== "" && nomes.length > 0) conexoes[conexao.trim()] = nomes;
  }

  if (organizacao.length === 0 && Object.keys(conexoes).length === 0) {
    delete atual[BOLSO_ESCRITA_LIBERADA];
    return atual;
  }
  return {
    ...atual,
    [BOLSO_ESCRITA_LIBERADA]: {
      ...(organizacao.length > 0 ? { organizacao } : {}),
      ...(Object.keys(conexoes).length > 0 ? { conexoes } : {}),
    },
  };
}

/**
 * O que o operador digitou (uma ferramenta por linha, ou separadas por vírgula)
 * virando a lista crua que `mesclarEscritaLiberada` filtra. Curinga aqui é
 * recusado com código próprio: a tela precisa dizer "não aceito" em vez de
 * salvar uma lista que não libera nada.
 */
export function separarNomesDigitados(texto: string): { nomes: string[]; curingas: string[] } {
  const nomes: string[] = [];
  const curingas: string[] = [];
  for (const pedaco of texto.split(/[\n,;]+/)) {
    const nome = pedaco.trim();
    if (nome === "") continue;
    if (ehCuringaDeEscrita(nome)) {
      curingas.push(nome);
      continue;
    }
    nomes.push(nome);
  }
  return { nomes, curingas };
}
