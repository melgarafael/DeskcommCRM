import { describe, expect, it } from "vitest";

import {
  chaveDeTelefone,
  encontrarContatosDuplicados,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";

/**
 * A detecção de duplicados — a regra que decide QUEM aparece na tela de fusão.
 *
 * O que estes casos guardam não é "achou o grupo": é que a detecção enxerga o
 * que o índice único NÃO enxerga. Os três índices únicos parciais de `contacts`
 * já garantem que duas linhas vivas não repetem a MESMA string; se a detecção
 * fosse só igualdade exata, ela não acharia nada num banco saudável e a tela
 * nasceria vazia para todo mundo. Por isso o caso do nono dígito e o do
 * `telefone_em_conflito` são os que importam.
 */
function contato(
  id: string,
  campos: Partial<ContatoParaDeduplicar> = {},
): ContatoParaDeduplicar {
  return {
    id,
    name: null,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    ...campos,
  };
}

describe("encontrarContatosDuplicados", () => {
  it("agrupa o MESMO celular escrito com e sem o nono dígito", () => {
    // 12 dígitos (como o `wa_id` às vezes chega) e 13 (como o brasileiro
    // digita). Strings distintas para o índice único, mesma pessoa no mundo.
    const grupos = encontrarContatosDuplicados([
      contato("a", { phone_number: "+553198966398" }),
      contato("b", { phone_number: "+5531998966398" }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(grupos[0]!.motivos).toContain("telefone");
  });

  it("agrupa o telefone que a ingestão do WhatsApp parkou em conflito", () => {
    // `fn_upsert_wa_contact` se recusa a fundir dentro do webhook e grava o
    // número em `source_metadata.telefone_em_conflito`, esperando por quem
    // opera. Sem este caminho, esse par nunca chegaria à tela.
    const grupos = encontrarContatosDuplicados([
      contato("dono-do-numero", { phone_number: "+5531998966398" }),
      contato("lid", {
        phone_number: null,
        source_metadata: { telefone_em_conflito: "+5531998966398" },
      }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.motivos).toContain("telefone_em_conflito");
  });

  it("une A-B-C num grupo só quando os critérios se encadeiam", () => {
    // A~B pelo telefone, B~C pelo e-mail. Oferecer duas fusões separadas
    // produziria a segunda já inválida — a primeira teria mesclado B.
    const grupos = encontrarContatosDuplicados([
      contato("a", { phone_number: "+5531998966398" }),
      contato("b", { phone_number: "+5531998966398", email: "j@ex.com" }),
      contato("c", { email: "J@Ex.com" }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(grupos[0]!.motivos).toEqual(["email", "telefone"]);
  });

  it("não oferece contato anonimizado nem contato já mesclado", () => {
    // L-04 é irreversível: reencaixar a linha anonimizada num contato ativo a
    // traria de volta ao atendimento pela porta dos fundos.
    const grupos = encontrarContatosDuplicados([
      contato("vivo", { phone_number: "+5531998966398" }),
      contato("anon", { phone_number: "+5531998966398", is_anonymized: true }),
      contato("lapide", { phone_number: "+5531998966398", is_merged_into: "vivo" }),
    ]);
    expect(grupos).toHaveLength(0);
  });

  it("não inventa grupo a partir de campo vazio", () => {
    // Controle negativo: três contatos sem telefone e sem e-mail têm a MESMA
    // chave vazia. Sem o descarte da chave vazia, a tela ofereceria fundir toda
    // a base de contatos criados à mão num cadastro só.
    const grupos = encontrarContatosDuplicados([
      contato("a"),
      contato("b"),
      contato("c", { email: "" }),
    ]);
    expect(grupos).toEqual([]);
  });
});

describe("principalSugerido", () => {
  it("sugere quem tem atividade mais recente, e no empate o mais antigo", () => {
    const grupo = encontrarContatosDuplicados([
      contato("velho", {
        phone_number: "+5531998966398",
        created_at: "2025-01-01T00:00:00.000Z",
        last_activity_at: "2026-01-01T00:00:00.000Z",
      }),
      contato("ativo", {
        phone_number: "+5531998966398",
        created_at: "2026-06-01T00:00:00.000Z",
        last_activity_at: "2026-08-01T00:00:00.000Z",
      }),
    ])[0]!;
    expect(principalSugerido(grupo)).toBe("ativo");
  });

  it("sem atividade em nenhum dos dois, sugere o mais antigo — nunca sorteia", () => {
    const grupo = encontrarContatosDuplicados([
      contato("novo", { phone_number: "+5531998966398", created_at: "2026-06-01T00:00:00.000Z" }),
      contato("antigo", { phone_number: "+5531998966398", created_at: "2025-01-01T00:00:00.000Z" }),
    ])[0]!;
    expect(principalSugerido(grupo)).toBe("antigo");
  });
});

describe("chaveDeTelefone", () => {
  it("devolve vazio para ausência, e só dígitos para um número", () => {
    expect(chaveDeTelefone(null)).toBe("");
    expect(chaveDeTelefone("   ")).toBe("");
    expect(chaveDeTelefone("+55 (31) 99896-6398")).toMatch(/^\d+$/);
  });
});

/**
 * O elo que o compilador NÃO fecha.
 *
 * `crm_lead_activities.type` é coluna de vocabulário ABERTO (sem CHECK, por
 * doutrina de migrations), e quem escreve `contacts_merged` é o corpo de
 * `fn_mesclar_contatos` — SQL, fora do alcance do `Record<ActivityType, ...>`.
 * Renomear de um lado só deixaria o banco aceitando calado e a timeline caindo
 * no rótulo genérico. Estas duas asserções são a única coisa que reprova isso.
 */
describe("o tipo de atividade que o SQL escreve é o que a timeline conhece", () => {
  const arquivos = [
    "supabase/migrations/20260904190000_0215_juntar_contatos_duplicados.sql",
    "supabase/baseline.sql",
  ];

  it("a migration E o apêndice do baseline gravam exatamente 'contacts_merged'", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const caminho of arquivos) {
      const sql = await readFile(caminho, "utf-8");
      // Controle positivo do instrumento: o arquivo certo foi lido.
      expect(sql, caminho).toContain("fn_mesclar_contatos");
      expect(sql, caminho).toContain("'contacts_merged'");
    }
  });

  it("a timeline tem rótulo próprio para 'contacts_merged' — nada de fallback", async () => {
    const { ACTIVITY_LABELS, ACTIVITY_LABEL_FALLBACK } = await import(
      "@/lib/leads/activity-vocabulary"
    );
    expect(Object.keys(ACTIVITY_LABELS)).toContain("contacts_merged");
    expect(ACTIVITY_LABELS.contacts_merged).not.toBe(ACTIVITY_LABEL_FALLBACK);
  });
});
