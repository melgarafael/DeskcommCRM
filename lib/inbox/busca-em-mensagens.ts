import type { SupabaseClient } from "@supabase/supabase-js";

import type { TrechoDeBusca } from "@/lib/types/messaging";

/**
 * A BUSCA DO INBOX ALCANÇA O TEXTO DAS MENSAGENS (issue #1355, fatia 1).
 *
 * ─── O defeito que este módulo existe para consertar ─────────────────────────
 * Até aqui a busca da lista casava `conversations.last_message_preview` — a
 * ÚLTIMA mensagem, truncada em 200 caracteres já na ingestão — e o contato. Quem
 * atende não consegue responder "onde o cliente falou sobre X?": o termo da 3ª
 * mensagem de um tique de 32 devolvia zero, e a pessoa rolava o fio à mão.
 *
 * ─── Por que o resultado entra na MESMA consulta da lista ───────────────────
 * O que este módulo devolve são IDS de conversa, e o handler os soma ao `or=`
 * que já existe (`last_message_preview` + contato). A consequência é a régua de
 * visibilidade: o `WHERE` da lista — organização, contato pessoal fora, canal
 * desativado fora, status, fila, dono, etiqueta — continua valendo para o ramo
 * novo, porque é o MESMO `WHERE`. Uma consulta própria devolvendo conversas
 * seria uma segunda régua, e a segunda régua é a que diverge.
 *
 * E a RLS não é reimplementada aqui: a rota usa o client da sessão
 * (`lib/supabase/server`), e `messages_select` (migration 0035) é
 * `exists (select 1 from conversations c where c.id = messages.conversation_id)`
 * — a policy de `messages` DELEGA para `fn_can_view_conversation`, a mesma
 * função que decide o que a lista mostra. Ou seja: a busca no texto não tem
 * como enxergar uma conversa que a pessoa não abre. O que prova isso contra o
 * banco é `tests/invariants/busca-em-mensagens-respeita-visibilidade.test.ts`.
 *
 * ─── O custo, medido (200.000 mensagens, 1 org, Postgres 15) ────────────────
 * Sem índice, `body ILIKE '%termo%'` é seq scan: 77 ms para um termo raro.
 * Com o índice GIN de trigrama (`idx_messages_body_trgm`, migration 9349):
 * 0,62 ms no termo raro e 22 ms no termo que casa 10% da tabela. O índice ocupa
 * 14 MB para uma tabela de 71 MB (20%) e a escrita paga ~8% (28,3 s contra
 * 26,3 s para 20.000 inserts). Full-text (`tsvector`) responderia a palavra
 * inteira, não a substring, e exigiria coluna + trigger de manutenção — o
 * trigrama já está no schema (`pg_trgm` em três índices) e resolve o caso.
 */

/**
 * Quantas conversas a busca por texto de mensagem entrega à lista.
 *
 * Não é estético: os ids viajam na querystring do PostgREST, junto com os ids
 * de contato, e a linha de requisição tem muro de 8.192 B (Kong/nginx). Cada id
 * custa 37 B, então 40 cabem em ~1,5 kB e deixam o resto do orçamento para a
 * busca por contato, que já existia.
 *
 * Truncar é a perda declarada desta fatia: termos muito comuns casam mais
 * conversas do que isto, e as que ficam de fora são as de mensagem mais ANTIGA
 * (a consulta ordena por `sent_at` decrescente). Preferimos a lista pobre à
 * tela quebrada por `414` — o mesmo raciocínio de `TETO_DE_CONTATOS_NA_BUSCA`.
 */
export const TETO_DE_CONVERSAS_NA_BUSCA_DE_MENSAGENS = 40;

/**
 * Quantas mensagens a consulta lê para preencher o teto acima.
 *
 * Uma conversa pode ter dezenas de mensagens casando o mesmo termo; sem folga,
 * o `limit` do teto seria consumido por uma só. 5x é a folga medida: o custo é
 * uma consulta indexada de poucas centenas de linhas.
 */
const MENSAGENS_LIDAS_POR_BUSCA = TETO_DE_CONVERSAS_NA_BUSCA_DE_MENSAGENS * 5;

/** Quantos caracteres do corpo viram trecho na tela. */
const LARGURA_DO_TRECHO = 120;

/**
 * As palavras do termo, já sem a gramática do `or=` do PostgREST.
 *
 * O termo chega saneado (`termoSeguroParaOr`): separadores viraram `*` e `%`/`_`
 * vieram escapados com `\`. Para achar o trecho no corpo, o que interessa é a
 * palavra — o `*` é curinga, não texto.
 */
export function palavrasDoTermo(termo: string): string[] {
  return termo
    .split("*")
    .map((p) => p.replace(/\\/g, "").trim())
    .filter((p) => p.length >= 2);
}

/**
 * O pedaço do corpo em volta do casamento, para a lista mostrar POR QUE aquela
 * conversa apareceu — sem isso, o resultado é um nome de cliente solto e quem
 * atende tem de abrir o tique para descobrir o motivo.
 *
 * A janela é centrada na primeira palavra do termo que existe no corpo (o
 * `ilike` garante que ao menos uma existe; quando o termo tem curinga, a ordem
 * entre elas é a mesma do padrão). Corta em limite de palavra para não entregar
 * "…roçam" no lugar de "orçamento…" e marca as reticências.
 */
export function trechoCasado(
  corpo: string | null | undefined,
  termo: string,
  largura: number = LARGURA_DO_TRECHO,
): string | null {
  const texto = (corpo ?? "").replace(/\s+/g, " ").trim();
  if (!texto) return null;

  const minusculo = texto.toLocaleLowerCase();
  let inicio = -1;
  let tamanho = 0;
  for (const palavra of palavrasDoTermo(termo)) {
    const achado = minusculo.indexOf(palavra.toLocaleLowerCase());
    if (achado >= 0) {
      inicio = achado;
      tamanho = palavra.length;
      break;
    }
  }
  // Sem casamento localizável (corpo casado só por curinga, por exemplo), o
  // começo do corpo é a resposta honesta: mostra a mensagem, não inventa âncora.
  if (inicio < 0) {
    return texto.length > largura ? `${texto.slice(0, largura).trimEnd()}…` : texto;
  }

  const antes = Math.max(0, Math.floor((largura - tamanho) / 3));
  let de = Math.max(0, inicio - antes);
  let ate = Math.min(texto.length, de + largura);
  de = Math.max(0, ate - largura);
  // Não começar nem terminar no meio de uma palavra.
  if (de > 0) {
    const espaco = texto.indexOf(" ", de);
    if (espaco >= 0 && espaco < inicio) de = espaco + 1;
  }
  if (ate < texto.length) {
    const espaco = texto.lastIndexOf(" ", ate);
    if (espaco > inicio + tamanho) ate = espaco;
  }
  const recorte = texto.slice(de, ate).trim();
  return `${de > 0 ? "…" : ""}${recorte}${ate < texto.length ? "…" : ""}`;
}

/**
 * As partes do trecho para a tela: o que casa vai em destaque, o resto é texto.
 *
 * Devolver as partes (e não HTML) mantém a decisão de apresentação no
 * componente e deixa a régua do casamento testável sem renderizar nada.
 */
export function partesDoTrecho(
  trecho: string,
  termo: string,
): Array<{ texto: string; casa: boolean }> {
  const palavras = palavrasDoTermo(termo)
    .map((p) => p.toLocaleLowerCase())
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  if (palavras.length === 0) return [{ texto: trecho, casa: false }];

  const minusculo = trecho.toLocaleLowerCase();
  const partes: Array<{ texto: string; casa: boolean }> = [];
  let cursor = 0;
  while (cursor < trecho.length) {
    const achado = palavras
      .map((p) => ({ p, i: minusculo.indexOf(p, cursor) }))
      .filter((c) => c.i >= 0)
      .sort((a, b) => a.i - b.i || b.p.length - a.p.length)[0];
    if (!achado) {
      partes.push({ texto: trecho.slice(cursor), casa: false });
      break;
    }
    if (achado.i > cursor) partes.push({ texto: trecho.slice(cursor, achado.i), casa: false });
    partes.push({ texto: trecho.slice(achado.i, achado.i + achado.p.length), casa: true });
    cursor = achado.i + achado.p.length;
  }
  return partes.filter((p) => p.texto.length > 0);
}

/**
 * As conversas cujo TEXTO de alguma mensagem casa o termo, com o trecho da
 * mensagem mais recente de cada uma.
 *
 * ⚠️ O filtro de organização é manual e obrigatório: a rota usa o client da
 * sessão, mas o MCP (`crm_list_conversations`) passa o admin client, que
 * bypassa a RLS. Sem o `.eq("organization_id")` a busca do agente varreria a
 * base inteira.
 *
 * Mensagem oculta no CRM (`metadata->>crm_hidden_at`) e mensagem revogada
 * (`revoked_at`) ficam FORA: o fio já não as mostra, e achar o texto delas pela
 * busca seria devolver pela porta dos fundos o que o gestor escondeu. A
 * anonimização (LGPD) não precisa de filtro aqui — `fn_lgpd_redact` troca o
 * corpo por `[mensagem anonimizada]` (baseline.sql, passo 3), então não há o
 * que reencontrar.
 *
 * Falha na consulta devolve mapa vazio em vez de derrubar a lista: a busca por
 * conteúdo é um ACRÉSCIMO, e o que já funcionava (nome, telefone, última
 * mensagem) não pode parar de funcionar por causa dela.
 */
export async function buscarConversasPorTextoDeMensagem(
  supabase: SupabaseClient,
  organizationId: string,
  termo: string,
  teto: number = TETO_DE_CONVERSAS_NA_BUSCA_DE_MENSAGENS,
): Promise<Map<string, TrechoDeBusca>> {
  // Sem palavra de 3+ letras o `pg_trgm` não extrai trigrama, o
  // `idx_messages_body_trgm` não ajuda e o `ILIKE` varre `messages` inteira a
  // cada tecla. O piso da busca é 2; abaixo de 3 ficam só nome, telefone e
  // última mensagem, como antes da #1355.
  if (!palavrasDoTermo(termo).some((p) => p.length >= 3)) return new Map();

  const { data, error } = await supabase
    .from("messages")
    .select("id, conversation_id, body, sent_at")
    .eq("organization_id", organizationId)
    .ilike("body", `%${termo}%`)
    .is("revoked_at", null)
    .is("metadata->>crm_hidden_at", null)
    .order("sent_at", { ascending: false })
    .limit(MENSAGENS_LIDAS_POR_BUSCA);

  if (error || !data) return new Map();

  const trechos = new Map<string, TrechoDeBusca>();
  for (const linha of data as unknown as Array<{
    id: string;
    conversation_id: string;
    body: string | null;
    sent_at: string;
  }>) {
    if (trechos.size >= teto) break;
    if (trechos.has(linha.conversation_id)) continue;
    const trecho = trechoCasado(linha.body, termo);
    if (!trecho) continue;
    trechos.set(linha.conversation_id, {
      message_id: linha.id,
      sent_at: linha.sent_at,
      trecho,
    });
  }
  return trechos;
}
