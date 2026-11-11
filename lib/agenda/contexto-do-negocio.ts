/**
 * O CONTEXTO DO NEGÓCIO QUE VAI DENTRO DO EVENTO DO GOOGLE (#4006).
 *
 * ─── Por que existe ────────────────────────────────────────────────────────
 *
 * O evento chegava ao Google com o título e a descrição do compromisso, e mais
 * nada. Quem abria a agenda no celular via "Reunião Estratégica" sem saber de
 * qual negócio se tratava, qual produto estava em jogo nem o telefone de quem
 * ia ser atendido. O CRM sabe tudo isso; o convite, não.
 *
 * ─── Por que é FUNÇÃO PURA, sem banco ──────────────────────────────────────
 *
 * O bloco é o pedaço da integração que dá para provar inteiro antes de existir
 * token de verdade: entra um contexto, sai uma string. Quem lê o banco é
 * `lib/agenda/google/contexto-do-negocio.ts`, e ele chama esta função.
 *
 * ─── As três regras que o texto carrega ────────────────────────────────────
 *
 * 1. **Sem negócio, sem bloco.** Compromisso avulso continua com a descrição
 *    que a pessoa escreveu — inventar "Negócio:" vazio seria pior que não ter.
 * 2. **Nada que veio do banco entra cru.** Nome de cliente e descrição de
 *    produto são texto de gente e vão para um campo que o Google interpreta
 *    como HTML; `<` e `&` são escapados.
 * 3. **O cliente também vê.** A ficha com e-mail é convidada do evento, e no
 *    Google todo convidado lê a descrição. É por isso que o interruptor
 *    (`calendar_event_types.levar_dados_do_negocio`) existe e nasce DESLIGADO:
 *    o bloco só sai do CRM quando alguém liga na tela do tipo.
 */

/** Uma linha da proposta do negócio (`crm_proposal_items`). */
export interface ItemDaProposta {
  descricao: string;
  quantidade: number;
}

/**
 * O que o compromisso sabe do negócio — já em forma de apresentação.
 *
 * `negocio` nulo é o caminho de TODO compromisso sem vínculo: o bloco inteiro
 * não existe. Os demais campos são opcionais porque cada um depende de uma
 * leitura que pode não devolver nada (proposta nunca enviada, contato sem
 * telefone, ficha anonimizada).
 */
export interface ContextoDoNegocio {
  negocio: { id: string; titulo: string } | null;
  etapa?: string | null;
  produtos?: readonly ItemDaProposta[];
  cliente?: { nome: string | null; telefone: string | null } | null;
  link?: string | null;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapa texto de terceiro para dentro do HTML que o Google aceita.
 *
 * O Google só aceita `b`, `br`, `ul`, `li` e `a` na descrição; o resto é
 * texto. Escapar é o que impede um nome com `<` de virar tag — e um produto
 * chamado "Plano <Anual>" é o caso banal, não o adversário.
 */
export function escaparHtml(valor: string): string {
  return valor.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** "Implantação (1×)" — a quantidade vai junto porque muda o que foi comprado. */
export function linhaDoProduto(item: ItemDaProposta): string {
  const descricao = item.descricao.trim();
  const quantidade = Number.isFinite(item.quantidade) && item.quantidade > 0 ? item.quantidade : 1;
  const rotulo = quantidade.toLocaleString("pt-BR");
  return `${escaparHtml(descricao)} (${rotulo}×)`;
}

/**
 * O bloco formatado, ou string vazia quando não há negócio.
 *
 * O desenho é o da issue #4006: `<b>` para o rótulo, `<br>` no fim da linha,
 * `<ul>/<li>` para os produtos e `<a>` para o link do CRM. A etapa entra
 * quando existe: numa reunião comercial, "Proposta enviada" é metade da
 * conversa.
 */
export function montarBlocoDoNegocio(contexto: ContextoDoNegocio | null | undefined): string {
  const negocio = contexto?.negocio;
  if (!negocio || !negocio.titulo.trim()) return "";

  const linhas: string[] = [
    `<b>Negócio:</b> ${escaparHtml(negocio.titulo.trim())}<br>`,
  ];

  const etapa = contexto?.etapa?.trim();
  if (etapa) linhas.push(`<b>Etapa:</b> ${escaparHtml(etapa)}<br>`);

  const produtos = (contexto?.produtos ?? []).filter((p) => p.descricao.trim());
  if (produtos.length) {
    linhas.push("<b>Produtos / serviços:</b>");
    linhas.push("<ul>");
    for (const produto of produtos) linhas.push(`  <li>${linhaDoProduto(produto)}</li>`);
    linhas.push("</ul>");
  }

  const nome = contexto?.cliente?.nome?.trim();
  const telefone = contexto?.cliente?.telefone?.trim();
  // Contato anonimizado (LGPD) chega aqui com os dois nulos, e as duas linhas
  // simplesmente não existem — não é "Cliente: Sem nome".
  if (nome) linhas.push(`<b>Cliente:</b> ${escaparHtml(nome)}<br>`);
  if (telefone) linhas.push(`<b>Telefone:</b> ${escaparHtml(telefone)}<br>`);

  const link = contexto?.link?.trim();
  if (link) linhas.push(`<a href="${escaparHtml(link)}">Abrir no CRM</a>`);

  return linhas.join("\n");
}

/**
 * Descrição final do evento: o texto da pessoa e, DEPOIS dele, o bloco.
 *
 * Nunca apaga: o texto escrito no compromisso continua sendo a primeira coisa
 * que se lê. Sem texto e sem bloco devolve `null` — o Google trata `""` como
 * descrição presente, e o evento nasceria com um campo vazio.
 */
export function descricaoDoEvento(
  texto: string | null | undefined,
  bloco: string | null | undefined,
): string | null {
  const partes = [texto?.trim() ?? "", bloco?.trim() ?? ""].filter(Boolean);
  return partes.length ? partes.join("\n\n") : null;
}
