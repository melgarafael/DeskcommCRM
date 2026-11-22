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
 * ─── O custo, medido (200.000 mensagens, 5.000 conversas, 1 org, Postgres 15) ─
 * A primeira versão deste módulo lia `messages` direto, com `.ilike("body")`.
 * Sem índice é seq scan: 77 ms para um termo raro, como dono da tabela. Com o
 * índice GIN de trigrama (`idx_messages_body_trgm`, migration 9349) o MESMO
 * papel cai para 0,42 ms — mas esse par NÃO é o que a rota vê.
 *
 * Sob `authenticated` (a rota usa o client da sessão) o plano é outro: o
 * `ilike` não é `leakproof`, e com RLS na tabela o planejador não pode usá-lo
 * como condição de índice antes de avaliar a política. Medido com a MESMA
 * predicate de hoje: `Seq Scan` sobre as 200.000 linhas, 197.753 avaliações de
 * `messages_select`, **2.110 ms** para devolver 3 mensagens (e 2.077 ms no
 * termo que casa 10%). O número "0,62 ms" que este cabeçalho já exibiu era o
 * do dono da tabela, não o da busca; fica corrigido aqui.
 *
 * O conserto (migration 9458) é o mesmo molde da busca de contatos (#4326): o
 * casamento de texto sai de dentro da RLS. `fn_mensagens_da_busca` —
 * `security definer` — confere a organização contra `fn_user_org_ids()`, repete
 * `organization_id`/`revoked_at`/`crm_hidden_at` e devolve só IDS, do mais
 * recente para o mais antigo; este módulo relê as linhas com o client da
 * SESSÃO por `id in (...)`, e igualdade de uuid é `leakproof`, então a RLS
 * continua decidindo o que a pessoa vê. Medido como `authenticated`: **4,3 ms**
 * no termo raro (mediana de 5; 4,2–6,7) e **39,2 ms** no termo que casa 10% —
 * dos quais 0,04 ms são o GIN e o resto é a leitura por id sob a política.
 *
 * O índice ocupa 24 MB para um heap de 49 MB (49%) e a escrita paga ~8%
 * (28,3 s contra 26,3 s para 20.000 inserts, medido na fatia do índice).
 * Full-text (`tsvector`) responderia a palavra inteira, não a substring, e
 * exigiria coluna + trigger de manutenção — o trigrama já está no schema
 * (`pg_trgm` em três índices) e resolve o caso.
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
 * o `limit` do teto seria consumido por uma só. 150 é a folga medida (3,75x o
 * teto de conversas), e o número tem um segundo dono: os ids voltam da função
 * e viajam na requisição de leitura, `id=in.(…)`. Cada uuid custa 36 B mais o
 * separador (`%2C`, 3 B); 150 cabem em ~5,9 kB, sob o muro de 8.192 B que a
 * querystring do PostgREST tem — 200 passariam de 7,8 kB e ficariam a menos de
 * 300 B da borda. Era 200 quando a consulta era uma só.
 */
const MENSAGENS_LIDAS_POR_BUSCA = 150;

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
 * ⚠️ O filtro de organização é manual e obrigatório — e agora mora na função.
 * A rota usa o client da sessão, mas o MCP (`crm_list_conversations`) passa o
 * admin client, que bypassa a RLS: sem o `organization_id`, a busca do agente
 * varreria a base inteira. `fn_mensagens_da_busca` repete o filtro nas DUAS
 * pontas (a guarda de `fn_user_org_ids()` para quem tem sessão e o `where
 * organization_id` da consulta), e a leitura por id continua sob RLS.
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

  // ─── 1. O CASAMENTO DE TEXTO, FORA DA RLS ──────────────────────────────────
  //
  // `ilike` não é `leakproof`: com RLS em `messages` o planejador não pode
  // usá-lo como condição de índice antes de avaliar a política, e a consulta
  // virava varredura da organização (2.110 ms por 200.000 mensagens). A função
  // é `security definer`, confere a organização contra `fn_user_org_ids()`,
  // repete os filtros de hoje e devolve SÓ ids — não amplia visibilidade, só
  // acelera QUAIS ids podem casar. O `*` vira `%` aqui porque é o que o
  // PostgREST fazia no `ilike`; sem isso um termo de duas palavras não casaria.
  const { data: achados, error: erroDaBusca } = await supabase.rpc(
    "fn_mensagens_da_busca",
    {
      p_org: organizationId,
      p_termo: termo.replace(/\*/g, "%"),
      p_limite: MENSAGENS_LIDAS_POR_BUSCA,
    },
  );

  if (erroDaBusca || !achados) return new Map();
  const ids = (achados as unknown as Array<{ message_id: string }>).map(
    (linha) => linha.message_id,
  );
  if (ids.length === 0) return new Map();

  // ─── 2. A LEITURA, SOB A RLS DE SEMPRE ─────────────────────────────────────
  //
  // O client é o da sessão e o filtro é por igualdade de id — `leakproof`, logo
  // o índice da PK entra e é `messages_select` que decide linha a linha. É o
  // que mantém a régua: a função diz quais ids PODEM casar; a política diz
  // quais a pessoa vê. Revogada e oculta continuam fora aqui também, além de já
  // saírem da função: o filtro repetido é barato e sobrevive a uma mudança lá.
  const { data, error } = await supabase
    .from("messages")
    .select("id, conversation_id, body, sent_at")
    .in("id", ids)
    .is("revoked_at", null)
    .is("metadata->>crm_hidden_at", null)
    .order("sent_at", { ascending: false });

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
