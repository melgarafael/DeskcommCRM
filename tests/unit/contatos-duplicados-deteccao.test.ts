import { describe, expect, it } from "vitest";

import {
  chaveDeTelefone,
  encontrarContatosDuplicados,
  ligadosPorMotivoForte,
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
    cpf_hash: null,
    wa_identity: null,
    wa_lid: null,
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

/**
 * O CPF (#4081). É igualdade de HASH — o documento já vem normalizado em sha256
 * pela ingestão —, e existe aqui pelo mesmo motivo do telefone exato: o índice
 * `uniq_contacts_org_cpf` nasce com `if not exists`, e no clone onde ele não
 * nasceu duas fichas vivas ficam com o mesmo CPF sem ninguém reclamar.
 */
describe("encontrarContatosDuplicados: CPF", () => {
  const HASH = "3f7a1c0d9b2e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e";

  it("CPF igual e não vazio une o par com o motivo `cpf` — mesmo com nomes diferentes", () => {
    // O caso real: a mesma pessoa entrou duas vezes, uma ficha pelo formulário e
    // outra pelo atendimento, com o nome escrito de outro jeito e telefones
    // diferentes. O que prova que é a mesma pessoa é o documento.
    const grupos = encontrarContatosDuplicados([
      contato("a", { name: "Maria Souza Lima", cpf_hash: HASH, phone_number: "+553198881111" }),
      contato("b", { name: "M. S. Lima", cpf_hash: HASH, phone_number: "+553198882222" }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(grupos[0]!.motivos).toEqual(["cpf"]);
  });

  it("CPF vazio ou nulo em AMBOS não une — vazio não é documento", () => {
    // O erro clássico: `null === null` e `'' === ''` são verdadeiros, e o mapa
    // por chave vazia agruparia a base inteira num cadastro só. Vazio tem de ser
    // DESCARTADO antes de virar chave, não comparado.
    const nulos = encontrarContatosDuplicados([contato("a"), contato("b")]);
    const vazios = encontrarContatosDuplicados([
      contato("a", { cpf_hash: "" }),
      contato("b", { cpf_hash: "" }),
    ]);
    expect(nulos).toEqual([]);
    expect(vazios).toEqual([]);
  });

  it("CPF igual encadeia com o telefone: A-B por CPF e B-C por telefone = UM grupo", () => {
    const grupos = encontrarContatosDuplicados([
      contato("a", { cpf_hash: HASH }),
      contato("b", { cpf_hash: HASH, phone_number: "+553198966398" }),
      contato("c", { phone_number: "+553198966398" }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(grupos[0]!.motivos).toEqual(["cpf", "telefone"]);
  });

  it("CPF diferente NÃO une, e o par de nome não entra pela porta do CPF", () => {
    const grupos = encontrarContatosDuplicados([
      contato("a", { name: "Ana Paula Silva", cpf_hash: HASH }),
      contato("b", { name: "Ana Paula Silva", cpf_hash: `${HASH.slice(0, -1)}f` }),
    ]);
    expect(grupos).toEqual([]);
  });

  it("ficha anonimizada ou já mesclada fica de fora mesmo com o CPF igual", () => {
    const grupos = encontrarContatosDuplicados([
      contato("vivo", { cpf_hash: HASH }),
      contato("anon", { cpf_hash: HASH, is_anonymized: true }),
      contato("lapide", { cpf_hash: HASH, is_merged_into: "vivo" }),
    ]);
    expect(grupos).toEqual([]);
  });
});

/**
 * O WhatsApp (#4081). `contacts.phone_whatsapp` NÃO é número — é a resposta
 * "este telefone tem WhatsApp?" (`sim`/`nao`/`nao_sei`), e tratá-lo como número
 * faria todo contato `sim` virar a mesma pessoa. O que é número de WhatsApp é o
 * `lids`: a identidade canônica `wa_identity` (0027) e a correlação `wa_lid` (0122),
 * as duas colunas GERADAS. As duas têm índice único criado com `if not exists`,
 * então no clone onde ele não nasceu a mesma conta de WhatsApp aparece duas vezes
 * e nada mais a liga.
 */
describe("encontrarContatosDuplicados: WhatsApp", () => {
  const LID = "100000000000001";

  it("a mesma `wa_identity` de lid une o par com o motivo `whatsapp` — mesmo com nomes diferentes", () => {
    // Sabotagem: tirar o mapa por `wa_identity` deixa este caso vermelho — as duas
    // fichas nascem do MESMO @lid e seguem separadas na tela.
    const grupos = encontrarContatosDuplicados([
      contato("a", { name: "Maria Souza", wa_identity: `lid:${LID}`, wa_lid: LID }),
      contato("b", { name: "M. Souza", wa_identity: `lid:${LID}`, wa_lid: LID }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(grupos[0]!.motivos).toEqual(["whatsapp"]);
  });

  it("a `wa_lid` reencontra o par quando a identidade mudou de lid para telefone", () => {
    // O caso que a 0122 descreve: a ficha nasceu `lid:X`; quando o telefone é
    // descoberto, `wa_identity` vira `phone:+Y` e SÓ `wa_lid` ainda liga as duas.
    const grupos = encontrarContatosDuplicados([
      contato("com-telefone", {
        phone_number: "+553****1111",
        wa_identity: "phone:+553****1111",
        wa_lid: LID,
      }),
      contato("so-lid", { wa_identity: `lid:${LID}`, wa_lid: LID }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.motivos).toEqual(["whatsapp"]);
  });

  it("`wa_identity`/`wa_lid` vazios em AMBOS não unem — vazio não é conta de WhatsApp", () => {
    // O erro simétrico ao do CPF: `"" === ""` agruparia toda ficha sem WhatsApp
    // num cadastro só.
    const grupos = encontrarContatosDuplicados([
      contato("a"),
      contato("b", { wa_identity: "", wa_lid: "" }),
      contato("c", { wa_identity: "  ", wa_lid: "  " }),
    ]);
    expect(grupos).toEqual([]);
  });

  it("WhatsApp encadeia com o CPF: A-B pela conta e B-C pelo documento = UM grupo", () => {
    const HASH = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233";
    const grupos = encontrarContatosDuplicados([
      contato("a", { wa_identity: `lid:${LID}`, wa_lid: LID }),
      contato("b", { wa_identity: `lid:${LID}`, wa_lid: LID, cpf_hash: HASH }),
      contato("c", { cpf_hash: HASH }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(grupos[0]!.motivos).toEqual(["cpf", "whatsapp"]);
  });

  it("o motivo `whatsapp` NÃO aparece quando só o telefone casa", () => {
    // `wa_identity` de ficha com telefone é `phone:+E164` — a MESMA string que o
    // motivo `telefone` já cobre. Marcá-la como WhatsApp faria todo par de telefone
    // dizer "WhatsApp" na tela, e o rótulo perderia o sentido.
    const grupos = encontrarContatosDuplicados([
      contato("a", { phone_number: "+553****6398", wa_identity: "phone:+553****6398" }),
      contato("b", { phone_number: "+553****6398", wa_identity: "phone:+553****6398" }),
    ]);
    expect(grupos[0]!.motivos).toEqual(["telefone"]);
  });
});

describe("ligadosPorMotivoForte", () => {
  const HASH = "aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233";

  it("o mesmo CPF liga o par — é o que faz `dispensar-par` recusar a dispensa", () => {
    const a = contato("a", { cpf_hash: HASH, phone_number: "+553198881111" });
    const b = contato("b", { cpf_hash: HASH, phone_number: "+553198882222" });
    expect(ligadosPorMotivoForte(a, b)).toBe(true);
  });

  it("CPF vazio ou ausente não liga nada", () => {
    const vazioA = contato("a", { cpf_hash: "" });
    const vazioB = contato("b", { cpf_hash: "" });
    expect(ligadosPorMotivoForte(vazioA, vazioB)).toBe(false);
    expect(ligadosPorMotivoForte(contato("a"), contato("b"))).toBe(false);
  });

  it("CPF diferente com telefone diferente não liga", () => {
    expect(ligadosPorMotivoForte(contato("a", { cpf_hash: HASH }), contato("b", { cpf_hash: `${HASH}b` }))).toBe(
      false,
    );
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
