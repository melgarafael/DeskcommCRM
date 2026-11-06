/**
 * #4006 — O QUE ENTRA NO BLOCO DO NEGÓCIO E QUEM PODE SER CONVIDADO.
 *
 * O outro arquivo (`agenda-4006-convidados-no-evento`) prova o RED/GREEN do
 * evento. Este prova as réguas que decidem o CONTEÚDO e a LISTA, que são as que
 * erram em silêncio:
 *
 *   · pessoa de OUTRA organização não vira convidada (a recusa é explícita);
 *   · e-mail inválido/vazio não vai para o Google (evento recusado inteiro);
 *   · compromisso sem negócio vinculado não inventa contexto;
 *   · contato anonimizado (LGPD) não leva nome nem telefone ao convite.
 */
import { describe, expect, it } from "vitest";

import {
  MAXIMO_DE_CONVIDADOS_DA_EQUIPE,
  estaNaAgendaDe,
  normalizarConvidadosDaEquipe,
  separarConvidadosDaEquipe,
} from "@/lib/agenda/convidados-da-equipe";
import {
  descricaoDoEvento,
  montarBlocoDoNegocio,
} from "@/lib/agenda/contexto-do-negocio";
import {
  emailsDeQuemSaiuDoEvento,
  emailsDosConvidadosDaEquipe,
} from "@/lib/agenda/google/convidados-da-equipe";
import { blocoDoNegocioDoEvento } from "@/lib/agenda/google/contexto-do-negocio";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const AGENDAMENTO = "22222222-2222-4222-8222-222222222222";
const LEAD = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const PROPOSTA = "77777777-7777-4777-8777-777777777777";
const TIPO = "88888888-8888-4888-8888-888888888888";

type Filtros = { eq: Record<string, unknown>; in: Record<string, unknown[]> };

/**
 * Um Supabase de mentira com a única coisa que os leitores usam: `from(t).select()`
 * encadeado e thenable. Os filtros são APLICADOS de verdade (eq e in), porque um
 * duble que devolve tudo passaria mesmo com a query errada — e a query errada
 * aqui é cross-tenant.
 */
function dbFalso(
  dados: Record<string, unknown[] | ((f: Filtros) => unknown[])>,
  usuarios: Record<string, { email: string | null; nome?: string | null }> = {},
): never {
  const filtrar = (tabela: string, f: Filtros): unknown[] => {
    const bruto = dados[tabela];
    const base = (typeof bruto === "function" ? bruto(f) : (bruto ?? [])) as Array<
      Record<string, unknown>
    >;
    let saida = [...base];
    for (const [coluna, valor] of Object.entries(f.eq)) {
      saida = saida.filter((linha) => linha[coluna] === valor);
    }
    for (const [coluna, valores] of Object.entries(f.in)) {
      saida = saida.filter((linha) => valores.includes(linha[coluna]));
    }
    return saida;
  };
  const montar = (tabela: string) => {
    const f: Filtros = { eq: {}, in: {} };
    const q = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        f.eq[coluna] = valor;
        return q;
      },
      in: (coluna: string, valores: unknown[]) => {
        f.in[coluna] = valores;
        return q;
      },
      is: (coluna: string, valor: unknown) => {
        f.eq[coluna] = valor;
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: filtrar(tabela, f)[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
        Promise.resolve({ data: filtrar(tabela, f), error: null }).then(ok, erro),
    };
    return q;
  };
  return {
    from: montar,
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = usuarios[id];
          if (!u) return { data: { user: null }, error: { message: "não existe" } };
          return {
            data: {
              user: { id, email: u.email, user_metadata: { full_name: u.nome ?? null } },
            },
            error: null,
          };
        },
      },
    },
  } as never;
}

describe("#4006 · o bloco do negócio", () => {
  it("monta o texto literal que vai para a descrição do evento", () => {
    const bloco = montarBlocoDoNegocio({
      negocio: { id: LEAD, titulo: "Plano Anual – Clínica Rosa" },
      etapa: "Proposta enviada",
      produtos: [
        { descricao: "Implantação", quantidade: 1 },
        { descricao: "Mensalidade", quantidade: 12 },
      ],
      cliente: { nome: "Rosa de Souza", telefone: "(11) 98765-4321" },
      link: "https://app.deskcomm.test/app/leads/555",
    });

    expect(bloco).toBe(
      [
        "<b>Negócio:</b> Plano Anual – Clínica Rosa<br>",
        "<b>Etapa:</b> Proposta enviada<br>",
        "<b>Produtos / serviços:</b>",
        "<ul>",
        "  <li>Implantação (1×)</li>",
        "  <li>Mensalidade (12×)</li>",
        "</ul>",
        "<b>Cliente:</b> Rosa de Souza<br>",
        "<b>Telefone:</b> (11) 98765-4321<br>",
        '<a href="https://app.deskcomm.test/app/leads/555">Abrir no CRM</a>',
      ].join("\n"),
    );
  });

  it("escapa o que veio do banco: nome com `<` não vira tag no evento de ninguém", () => {
    const bloco = montarBlocoDoNegocio({
      negocio: { id: LEAD, titulo: "Plano <Anual> & Cia" },
      cliente: { nome: null, telefone: null },
    });
    expect(bloco).toContain("Plano &lt;Anual&gt; &amp; Cia");
    expect(bloco).not.toContain("<Anual>");
  });

  it("sem negócio, bloco vazio — e a descrição continua sendo só o texto da pessoa", () => {
    expect(montarBlocoDoNegocio(null)).toBe("");
    expect(montarBlocoDoNegocio({ negocio: null })).toBe("");
    expect(descricaoDoEvento("Alinhar proposta", "")).toBe("Alinhar proposta");
    expect(descricaoDoEvento("Alinhar proposta", null)).toBe("Alinhar proposta");
  });

  it("sem texto e sem bloco devolve null (o Google trata `\"\"` como campo presente)", () => {
    expect(descricaoDoEvento(null, "")).toBeNull();
    expect(descricaoDoEvento("   ", null)).toBeNull();
  });
});

describe("#4006 · quem pode ser convidado da equipe", () => {
  it("normaliza: sem repetidos, sem vazios, em minúsculas, com teto", () => {
    expect(
      normalizarConvidadosDaEquipe([
        "A1",
        " a1 ",
        "",
        "b2",
        ...Array.from({ length: 30 }, (_, i) => `x${i}`),
      ]),
    ).toHaveLength(MAXIMO_DE_CONVIDADOS_DA_EQUIPE);
    expect(normalizarConvidadosDaEquipe(["A1", " a1 ", "", "b2"])).toEqual(["a1", "b2"]);
    expect(normalizarConvidadosDaEquipe(null)).toEqual([]);
  });

  it("quem NÃO é da organização volta como recusa explícita, não como descarte", () => {
    const { aceitos, recusados } = separarConvidadosDaEquipe(
      ["da-casa", "de-fora"],
      new Set(["da-casa"]),
    );
    expect(aceitos).toEqual(["da-casa"]);
    expect(recusados).toEqual(["de-fora"]);
  });
});

describe("#4006 · de quem é a agenda em que o compromisso aparece", () => {
  const compromisso = { responsavelId: "dono", convidadosDaEquipe: ["bruna"] };

  it("o responsável e o convidado veem; quem ficou de fora, não", () => {
    expect(estaNaAgendaDe(compromisso, "dono")).toBe(true);
    expect(estaNaAgendaDe(compromisso, "bruna")).toBe(true);
    expect(estaNaAgendaDe(compromisso, "eva")).toBe(false);
  });

  it("bloco sem a lista (ocupação do Google, servidor antigo) cai só no responsável", () => {
    expect(estaNaAgendaDe({ responsavelId: "dono" }, "dono")).toBe(true);
    expect(estaNaAgendaDe({ responsavelId: "dono" }, "bruna")).toBe(false);
  });
});

describe("#4006 · o e-mail do convite, resolvido pelo banco", () => {
  const membros = [
    { user_id: "u-sdr", organization_id: ORG, revoked_at: null },
    { user_id: "u-closer", organization_id: ORG, revoked_at: null },
    { user_id: "u-saiu", organization_id: ORG, revoked_at: "2026-01-01T00:00:00Z" },
    { user_id: "u-de-fora", organization_id: OUTRA_ORG, revoked_at: null },
  ];

  it("usa a conta Google CONECTADA (saudável) antes do e-mail de login", async () => {
    const db = dbFalso(
      {
        user_organizations: membros,
        calendar_connections: [
          {
            user_id: "u-sdr",
            organization_id: ORG,
            account_email: "sdr.calendario@deskcomm.test",
            status: "healthy",
            updated_at: "2026-11-01T00:00:00Z",
          },
        ],
      },
      { "u-sdr": { email: "sdr@login.test" } },
    );
    await expect(emailsDosConvidadosDaEquipe(db, ORG, ["u-sdr"])).resolves.toEqual([
      { user_id: "u-sdr", email: "sdr.calendario@deskcomm.test", nome: null },
    ]);
  });

  it("sem conta conectada, cai no e-mail de login — a pessoa continua vendo o compromisso", async () => {
    const db = dbFalso(
      { user_organizations: membros, calendar_connections: [] },
      { "u-closer": { email: "closer@login.test", nome: "Closer" } },
    );
    await expect(emailsDosConvidadosDaEquipe(db, ORG, ["u-closer"])).resolves.toEqual([
      { user_id: "u-closer", email: "closer@login.test", nome: "Closer" },
    ]);
  });

  it("pessoa de OUTRA organização é recusada mesmo com id válido (a rota pode ser burlada)", async () => {
    const db = dbFalso(
      { user_organizations: membros, calendar_connections: [] },
      { "u-de-fora": { email: "intruso@outra.test" } },
    );
    await expect(emailsDosConvidadosDaEquipe(db, ORG, ["u-de-fora"])).resolves.toEqual([]);
  });

  it("membro revogado não vira convidado (o id pode estar salvo na tela de alguém)", async () => {
    const db = dbFalso(
      { user_organizations: membros, calendar_connections: [] },
      { "u-saiu": { email: "saiu@login.test" } },
    );
    await expect(emailsDosConvidadosDaEquipe(db, ORG, ["u-saiu"])).resolves.toEqual([]);
  });

  it("e-mail inválido ou ausente NÃO vai para o Google (a recusa custaria o evento inteiro)", async () => {
    const db = dbFalso(
      { user_organizations: membros, calendar_connections: [] },
      { "u-sdr": { email: "sem-arroba" }, "u-closer": { email: null } },
    );
    await expect(emailsDosConvidadosDaEquipe(db, ORG, ["u-sdr", "u-closer"])).resolves.toEqual([]);
  });
});

describe("#4006 · quem sai do evento", () => {
  const membros = [
    { user_id: "u-fica", organization_id: ORG, revoked_at: null },
    { user_id: "u-tirado", organization_id: ORG, revoked_at: null },
    { user_id: "u-saiu", organization_id: ORG, revoked_at: "2026-01-01T00:00:00Z" },
    { user_id: "u-de-fora", organization_id: OUTRA_ORG, revoked_at: null },
  ];
  const usuarios = {
    "u-fica": { email: "fica@login.test" },
    "u-tirado": { email: "tirado@login.test" },
    "u-saiu": { email: "saiu@login.test" },
    "u-de-fora": { email: "fora@login.test" },
  };

  it("tirado da lista sai; quem está na lista e ativo fica", async () => {
    const db = dbFalso({ user_organizations: membros, calendar_connections: [] }, usuarios);
    await expect(
      emailsDeQuemSaiuDoEvento(db, ORG, ["u-fica", "u-tirado"], ["u-fica"]),
    ).resolves.toEqual(["tirado@login.test"]);
  });

  it("revogado sai mesmo seguindo na lista, com a conta Google que tiver, saudável ou não", async () => {
    const db = dbFalso(
      {
        user_organizations: membros,
        calendar_connections: [
          {
            user_id: "u-saiu",
            organization_id: ORG,
            account_email: "saiu.calendario@deskcomm.test",
            status: "disconnected",
          },
        ],
      },
      usuarios,
    );
    await expect(emailsDeQuemSaiuDoEvento(db, ORG, ["u-saiu"], ["u-saiu"])).resolves.toEqual([
      "saiu.calendario@deskcomm.test",
      "saiu@login.test",
    ]);
  });

  it("id que nunca foi desta organização não resolve e-mail nenhum", async () => {
    const db = dbFalso({ user_organizations: membros, calendar_connections: [] }, usuarios);
    await expect(emailsDeQuemSaiuDoEvento(db, ORG, ["u-de-fora"], [])).resolves.toEqual([]);
  });

  it("evento sem lista publicada não custa leitura", async () => {
    const consultas: string[] = [];
    const db = { from: (t: string) => consultas.push(t) } as never;
    await expect(emailsDeQuemSaiuDoEvento(db, ORG, [""], ["u-fica"])).resolves.toEqual([]);
    expect(consultas).toEqual([]);
  });

  it("falha ao ler o vínculo LANÇA: a lista publicada não pode avançar sem o e-mail", async () => {
    const q = {
      select: () => q,
      eq: () => q,
      in: async () => ({ data: null, error: { message: "fora do ar" } }),
    };
    const db = { from: () => q } as never;
    await expect(emailsDeQuemSaiuDoEvento(db, ORG, ["u-tirado"], [])).rejects.toThrow();
  });

  it("falha do cadastro de usuários também LANÇA, em vez de esquecer quem saiu", async () => {
    const db = dbFalso({ user_organizations: membros, calendar_connections: [] }, {});
    await expect(emailsDeQuemSaiuDoEvento(db, ORG, ["u-tirado"], [])).rejects.toThrow();
  });
});

describe("#4006 · o contexto lido do CRM", () => {
  const agendamento = {
    id: AGENDAMENTO,
    contact_id: CONTATO,
    description: "Alinhar proposta",
    starts_at: "2026-11-10T17:00:00.000Z",
    event_type_id: TIPO,
  };
  const futuro = new Date("2026-11-01T00:00:00.000Z");

  const dados = {
    crm_lead_links: [
      { lead_id: LEAD, organization_id: ORG, target_id: AGENDAMENTO, target_kind: "appointment" },
    ],
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        title: "Plano Anual – Clínica Rosa",
        stage_id: "etapa-1",
        crm_stages: { name: "Proposta enviada" },
      },
    ],
    contacts: [
      {
        id: CONTATO,
        organization_id: ORG,
        name: "Rosa de Souza",
        display_name: null,
        phone_number: "5511987654321",
        is_anonymized: false,
      },
    ],
    crm_proposals: [
      { id: PROPOSTA, organization_id: ORG, lead_id: LEAD, status: "enviada", sent_at: "2026-10-20T00:00:00Z", created_at: "2026-10-19T00:00:00Z" },
    ],
    crm_proposal_items: [
      { proposal_id: PROPOSTA, organization_id: ORG, descricao: "Implantação", quantidade: 1, position: 1 },
    ],
    calendar_event_types: [
      { id: TIPO, organization_id: ORG, levar_dados_do_negocio: true },
    ],
  };

  it("compromisso SEM negócio vinculado não inventa contexto", async () => {
    const db = dbFalso({ ...dados, crm_lead_links: [] });
    await expect(blocoDoNegocioDoEvento(db, ORG, agendamento, futuro)).resolves.toBe("");
  });

  it("leva negócio, etapa, produto e telefone do negócio vinculado", async () => {
    const db = dbFalso(dados);
    const bloco = await blocoDoNegocioDoEvento(db, ORG, agendamento, futuro);
    expect(bloco).toContain("<b>Negócio:</b> Plano Anual – Clínica Rosa");
    expect(bloco).toContain("<b>Etapa:</b> Proposta enviada");
    expect(bloco).toContain("<li>Implantação (1×)</li>");
    expect(bloco).toContain("<b>Telefone:</b>");
  });

  it("compromisso que já passou não ganha bloco (reescrever o passado é mandar e-mail à toa)", async () => {
    const db = dbFalso(dados);
    const depois = new Date("2027-01-01T00:00:00.000Z");
    await expect(blocoDoNegocioDoEvento(db, ORG, agendamento, depois)).resolves.toBe("");
  });

  it("o interruptor do tipo desliga o bloco — nome interno de negócio não vai ao cliente", async () => {
    const db = dbFalso({
      ...dados,
      calendar_event_types: [{ id: TIPO, organization_id: ORG, levar_dados_do_negocio: false }],
    });
    await expect(blocoDoNegocioDoEvento(db, ORG, agendamento, futuro)).resolves.toBe("");
  });

  // Doc 272 = B: o bloco nasce DESLIGADO. Só `true` lido do banco leva o
  // dado do cliente para o Google; sem decisão de ninguém, nada sai.
  it("tipo sem a chave gravada (padrão de fábrica) não leva o bloco", async () => {
    const db = dbFalso({ ...dados, calendar_event_types: [{ id: TIPO, organization_id: ORG }] });
    await expect(blocoDoNegocioDoEvento(db, ORG, agendamento, futuro)).resolves.toBe("");
  });

  it("compromisso sem tipo, ou com tipo de outra organização, não leva o bloco", async () => {
    const db = dbFalso(dados);
    await expect(
      blocoDoNegocioDoEvento(db, ORG, { ...agendamento, event_type_id: null }, futuro),
    ).resolves.toBe("");
    const outra = dbFalso({
      ...dados,
      calendar_event_types: [{ id: TIPO, organization_id: "outra-org", levar_dados_do_negocio: true }],
    });
    await expect(blocoDoNegocioDoEvento(outra, ORG, agendamento, futuro)).resolves.toBe("");
  });

  it("contato anonimizado (LGPD) não leva nome nem telefone ao convite", async () => {
    const db = dbFalso({
      ...dados,
      contacts: [
        {
          id: CONTATO,
          organization_id: ORG,
          name: "Rosa de Souza",
          display_name: null,
          phone_number: "5511987654321",
          is_anonymized: true,
        },
      ],
    });
    const bloco = await blocoDoNegocioDoEvento(db, ORG, agendamento, futuro);
    expect(bloco).not.toContain("Rosa de Souza");
    expect(bloco).not.toContain("Telefone");
  });
});
