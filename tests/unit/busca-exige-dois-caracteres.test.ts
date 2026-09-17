import { describe, expect, it } from "vitest";

import { listConversationsQuerySchema } from "@/lib/schemas";
import { PISO_DA_BUSCA } from "@/lib/inbox/termo-de-busca";

/**
 * O campo de busca do Inbox ia ao banco com UM caractere.
 *
 * Medido numa instalação real: `?search=a` devolvia a lista inteira. Lista
 * inteira sob busca não é resposta — é ruído que PARECE resposta, que é o modo
 * de falha mais caro numa tela de atendimento: o atendente conclui que achou.
 *
 * O handler já aplica exatamente este raciocínio ao telefone, com a justificativa
 * escrita lá ("12 casaria metade da base… pior que não achar, porque PARECE que
 * funcionou"). Faltava aplicá-lo ao texto.
 *
 * O piso mora no SCHEMA, e não no componente, porque a rota é pública e o
 * componente não é a única porta: o schema é o contrato que toda entrada
 * atravessa.
 */
describe("a busca não vai ao banco com 1 caractere", () => {
  it("CONTROLE: termo de 2 caracteres é aceito", () => {
    const r = listConversationsQuerySchema.safeParse({ search: "an" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.search).toBe("an");
  });

  it("termo de 1 caractere é RECUSADO", () => {
    expect(listConversationsQuerySchema.safeParse({ search: "a" }).success).toBe(false);
  });

  it("espaço em volta não conta como caractere", () => {
    expect(listConversationsQuerySchema.safeParse({ search: " a " }).success).toBe(false);
  });

  it("o termo chega ao handler já aparado", () => {
    const r = listConversationsQuerySchema.safeParse({ search: "  ana  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.search).toBe("ana");
  });

  /**
   * A TELA usa o mesmo piso (components/inbox/InboxLayout.tsx) para não pedir o
   * que a rota recusa — o hook chama `showApiError`, então pedir e ser recusado
   * faz piscar um erro na cara de quem digita a primeira letra.
   *
   * Este caso deriva do PRÓPRIO `PISO_DA_BUSCA` em vez de repetir o número: se
   * alguém mudar a constante, o teste acompanha e a tela acompanha. Repetir `2`
   * aqui faria os três divergirem em silêncio.
   */
  it("o schema honra exatamente o PISO_DA_BUSCA que a tela lê", () => {
    const curto = "a".repeat(PISO_DA_BUSCA - 1);
    const exato = "a".repeat(PISO_DA_BUSCA);
    expect(listConversationsQuerySchema.safeParse({ search: curto }).success).toBe(false);
    expect(listConversationsQuerySchema.safeParse({ search: exato }).success).toBe(true);
  });
});
