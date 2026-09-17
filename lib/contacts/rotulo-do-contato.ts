/**
 * COMO SE CHAMA ESTA PESSOA NA TELA — uma decisão, um lugar.
 *
 * ═══ POR QUE CENTRALIZAR ═══
 *
 * A mesma cadeia `display_name || name || phone_number || <literal>` estava
 * copiada em **seis** arquivos, com **quatro** finais diferentes (`Sem nome`,
 * `Contato sem nome`, `—`, `—`) e duas variações de conteúdo: a ficha do contato
 * e a tabela de contatos **não usavam o telefone**, então quem tinha número mas
 * não tinha nome aparecia como "Sem nome" numa tela e com o número em outra.
 *
 * Seis cópias não divergem por descuido — divergem porque cada tela nova
 * reescreve a cadeia do jeito que parece certo naquele arquivo. A sétima ia
 * nascer com um quinto final.
 *
 * ═══ A REGRA QUE NENHUMA DELAS TINHA ═══
 *
 * **Identificador técnico não é nome de gente.** `Contato 543134@lid` esteve na
 * tela do atendente da produção; o produtor daquela string morreu, mas o dado
 * ficou, e o passo seguinte da spec 17 vai LER o nome do contato para escrever o
 * título do card no kanban — sem esta guarda, o resíduo vaza para o quadro.
 *
 * E o consumidor não é só humano: `lib/ai/render-system-prompt.ts` põe o nome do
 * contato no prompt do modelo. Um rótulo técnico ali é a mesma doença que a spec
 * 16 mediu em 30% dos turnos — vocabulário de máquina chegando ao cliente.
 */

import { phoneForDisplay } from "@/lib/channels/phone-variants";

/** O que qualquer tela precisa saber para chamar alguém pelo nome. */
export interface ContatoNomeavel {
  display_name?: string | null;
  name?: string | null;
  phone_number?: string | null;
}

/** Quando não há nada apresentável. Um literal, não quatro. */
export const SEM_NOME = "Sem nome";

/**
 * Cheira a identificador de máquina?
 *
 * Conservador de propósito: recusar um nome legítimo é pior que deixar passar um
 * técnico, porque o primeiro apaga a identidade de uma pessoa real. Por isso as
 * âncoras — `Contato 5431` sai, `Contato Comercial da Loja` fica.
 */
export function ehIdentificadorTecnico(valor: string): boolean {
  const v = valor.trim();
  if (v === "") return true;
  // Sufixos de endereçamento do WhatsApp em qualquer posição.
  if (/@(lid|c\.us|s\.whatsapp\.net|g\.us)\b/i.test(v)) return true;
  // O rótulo que o código antigo inventava: "Contato " + dígitos, e só isso.
  if (/^contato\s+\d+$/i.test(v)) return true;
  // Só dígitos e longo demais para ser apelido — é id, não nome. Telefone
  // formatado (com +, espaço ou hífen) NÃO cai aqui: ele é um rótulo útil e tem
  // caminho próprio abaixo.
  if (/^\d{9,}$/.test(v)) return true;
  return false;
}

/**
 * O nome de gente: primeiro o que uma pessoa escolheu (`name` — "Editar
 * contato", proposta de dado aprovada), depois o que o canal informou
 * (`display_name` — o perfil do WhatsApp, gravado pela ingestão). `null` quando
 * não há nome apresentável; quem chama decide o fallback. Quem FALA com a
 * pessoa (prompt, lembrete) não pode cair no telefone, por isso esta metade
 * existe separada do rótulo.
 *
 * ─── POR QUE `name` VEM PRIMEIRO, e o que teria de mudar para inverter ──────
 *
 * A revisão da issue #906 deixou a pergunta aberta: "e se `display_name` for o
 * nome escolhido?". Ele não é, e quem responde é onde cada coluna é ESCRITA.
 *
 *  - `name` é a coluna editável pela pessoa: "Novo contato" e "Editar contato"
 *    gravam nela, o CSV a preenche pela coluna `nome`, e é ela que
 *    `lib/contacts/proposta-de-dado.ts` escreve quando um humano APROVA uma
 *    proposta (`CAMPOS_PROPONIVEIS = ["email", "name", "phone_number"]` —
 *    `display_name` não está na lista).
 *  - `display_name` é escrito pela INGESTÃO (`fn_upsert_wa_contact`, a partir do
 *    `pushName` do aparelho). Nenhum formulário do produto o edita: a única
 *    aparição dele nas telas de contato é um `<dd>` de exibição em
 *    `app/app/contacts/[id]/_client.tsx` e um cabeçalho de ordenação.
 *
 * ⚠️ UMA RESSALVA, porque "nenhuma tela escreve `display_name`" seria FALSO: o
 * import de CSV escreve, pela coluna `apelido`/`nome_de_exibicao`
 * (lib/contacts/csv.ts). Isso não muda a ordem — reforça: quem digitou um
 * APELIDO numa planilha não pediu que ele vencesse o nome do cadastro.
 *
 * Inverter a ordem aqui, portanto, não é trocar uma linha: pediria antes dar
 * editor a `display_name`, e aí a ficha teria dois campos chamados "nome".
 */
export function nomeDoContato(c: ContatoNomeavel | null | undefined): string | null {
  if (!c) return null;
  for (const bruto of [c.name, c.display_name]) {
    const v = (bruto ?? "").trim();
    if (v !== "" && !ehIdentificadorTecnico(v)) return v;
  }
  return null;
}

/**
 * O rótulo. O nome de gente (`nomeDoContato`), depois o número — e só então a
 * admissão de que não se sabe o nome.
 *
 * Celular BR aparece COM o nono dígito: `+553284793302` e `+5532984793302` são
 * a mesma pessoa, e o 9 é o que o atendente espera copiar.
 */
export function rotuloDoContato(
  c: ContatoNomeavel | null | undefined,
  t: (texto: string) => string = (texto) => texto,
): string {
  if (!c) return t(SEM_NOME);

  const nome = nomeDoContato(c);
  if (nome) return nome;

  const tel = (c.phone_number ?? "").trim();
  if (tel !== "") return phoneForDisplay(tel);

  return t(SEM_NOME);
}
