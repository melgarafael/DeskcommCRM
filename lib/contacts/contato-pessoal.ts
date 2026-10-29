/**
 * A RÉGUA ÚNICA DE "CONTATO PESSOAL" (spec 21).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * A marca mora numa coluna só (`contacts.is_personal`, migration 0563) e a
 * pergunta é sempre a mesma: "esta conversa é de alguém que a operação tirou
 * do jogo?". O que muda de caminho para caminho é o que fazer com a RESPOSTA —
 * e só isso deveria mudar.
 *
 * A pergunta já esteve escrita à mão em cada caminho (entrada, automação,
 * campanha, follow-up, relógio, MCP). Enquanto era `contacts.is_personal`
 * lido com o mesmo `=== true` em todos, a duplicação era feia e barata. O
 * primeiro caminho que precisou dela SEM ter o `contact_id` na mão — a
 * derivação de mídia, que só conhece a `conversation_id` da mensagem — seria
 * o primeiro a inventar uma segunda régua: um SELECT em `conversations`
 * decidindo sozinho o que é "pessoal". Duas réguas divergem na primeira vez
 * que alguém acrescentar uma condição (contato interno, grupo, contato
 * arquivado) — e a que fica para trás é sempre a que gasta dinheiro.
 *
 * ─── O que NÃO mora aqui ────────────────────────────────────────────────────
 *
 * A POLÍTICA da dúvida. `erro` volta como dado, não como exceção, e quem chama
 * decide: a entrada de mensagem segue (a mensagem já está gravada; falhar ali
 * viraria 500 para o provider e tempestade de reentregas), a derivação de
 * mídia deixa de gastar token (o conteúdo é privado e ninguém da operação vai
 * ler). Uma função só, duas políticas explicitamente declaradas em cada
 * chamador — do jeito que está escrito em `lib/channels/pos-entrada.ts` e em
 * `workers/media-derive-worker.ts`.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** O mínimo que a régua precisa ver de uma linha de `contacts`. */
export interface MarcaDePessoal {
  is_personal?: boolean | null;
}

/**
 * A PERGUNTA, num lugar só.
 *
 * `=== true` e não `!== false` de propósito: a coluna é NOT NULL com default
 * false, mas um SELECT que não a pediu entrega `undefined` — e `undefined`
 * lido como "não é pessoal" é justamente o defeito que a etapa 2 da spec
 * combate (ver `tests/unit/contato-pessoal-selects.test.ts`). Na dúvida, a
 * marca não está confirmada.
 */
export function ehContatoPessoal(contato: MarcaDePessoal | null | undefined): boolean {
  return contato?.is_personal === true;
}

/**
 * O que a leitura respondeu.
 *
 * `pessoal: false` com `erro` preenchido NÃO é "não é pessoal" — é "não deu
 * para saber". Quem chama tem de olhar `erro` antes de tratar o `false` como
 * resposta.
 */
export type LeituraDePessoal = { pessoal: boolean; erro: string | null };

/** Mensagem de erro curta: o recibo de evento não carrega stack. */
function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "desconhecido";
}

/**
 * A consulta canônica: `contacts.is_personal` da organização do chamador.
 *
 * Sem `contactId` não há pergunta a fazer (conversa sem contato, mensagem de
 * sistema): devolve "não é pessoal" sem tocar o banco.
 */
export async function lerPessoalDoContato(
  admin: Admin,
  onde: { organizationId: string; contactId: string | null | undefined },
): Promise<LeituraDePessoal> {
  if (!onde.contactId) return { pessoal: false, erro: null };
  try {
    const { data, error } = await admin
      .from("contacts")
      .select("is_personal")
      .eq("organization_id", onde.organizationId)
      .eq("id", onde.contactId)
      .maybeSingle();
    if (error) return { pessoal: false, erro: error.message };
    return { pessoal: ehContatoPessoal(data as MarcaDePessoal | null), erro: null };
  } catch (err) {
    return { pessoal: false, erro: mensagemDoErro(err) };
  }
}

/**
 * O mesmo, para quem só tem a conversa (o worker de mídia recebe
 * `message.conversation_id` e nada mais).
 *
 * A resolução do dono é uma LINHA de `conversations`; a decisão é sempre
 * `ehContatoPessoal` sobre `contacts.is_personal`. Nenhuma condição nova é
 * inventada aqui — de propósito: quem quiser mudar o que é "pessoal" muda a
 * régua, e muda para todos os caminhos de uma vez.
 */
export async function lerPessoalDaConversa(
  admin: Admin,
  onde: { organizationId: string; conversationId: string | null | undefined },
): Promise<LeituraDePessoal> {
  if (!onde.conversationId) return { pessoal: false, erro: null };
  let contactId: string | null;
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("contact_id")
      .eq("organization_id", onde.organizationId)
      .eq("id", onde.conversationId)
      .maybeSingle();
    if (error) return { pessoal: false, erro: error.message };
    contactId = (data as { contact_id?: string | null } | null)?.contact_id ?? null;
  } catch (err) {
    return { pessoal: false, erro: mensagemDoErro(err) };
  }
  return lerPessoalDoContato(admin, { organizationId: onde.organizationId, contactId });
}
