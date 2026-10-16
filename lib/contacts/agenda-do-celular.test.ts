/**
 * "Sincronizar agenda do celular" (#2736) — o serviço, com dublês nas duas
 * fronteiras (transporte do canal e banco). O que se prova aqui é a régua que a
 * tela promete: quem NÃO está salvo na agenda não entra, número já cadastrado
 * não vira duplicata (nem o de 12 dígitos achando o de 13), a paginação anda
 * até a página curta, os dois tetos cortam com `truncado` e a falha de um
 * contato não mata o lote.
 */
import { describe, expect, it, vi } from "vitest";

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import type { ContatoDoAparelho } from "@/lib/channels";

import {
  candidatoDaAgenda,
  sincronizarAgendaDoCelular,
  TAMANHO_DA_PAGINA,
  TETO_DE_IMPORTACOES,
  TETO_DE_LEITURA,
  type AgendaDeps,
} from "./agenda-do-celular";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

function agenda(id: string, extra: Partial<ContatoDoAparelho> = {}): ContatoDoAparelho {
  return { id, name: null, pushname: null, isMyContact: true, isWAContact: true, isMe: false, ...extra };
}

function fakeDeps(opcoes: {
  paginas?: ContatoDoAparelho[][];
  /** Telefones já gravados no CRM (como `contacts.phone_number` guarda). */
  existentes?: string[];
  /** Telefones cuja RPC lança — a falha de um não pode matar o lote. */
  falhaUpsertEm?: string[];
  /** A RPC devolve null (anomalia — conta como erro, não como importado). */
  upsertNulo?: boolean;
  /** O `contact.created` falha — a criação JÁ aconteceu e não se desfaz. */
  falhaEmit?: boolean;
  /** O carimbo de origem falha — idem: o contato já existe. */
  falhaMarca?: boolean;
} = {}) {
  const paginas = opcoes.paginas ?? [[]];
  const variantesNoBanco = new Set((opcoes.existentes ?? []).flatMap(phoneLookupVariants));
  const offsets: number[] = [];
  const upserts: Array<{ telefone: string; chatId: string; notify: string | null }> = [];
  const emits: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const marcados: string[] = [];
  const deps: AgendaDeps = {
    listarPagina: async (_session, pagina) => {
      offsets.push(pagina.offset);
      return paginas[pagina.offset / TAMANHO_DA_PAGINA] ?? [];
    },
    telefonesExistentes: async (_org, variantes) =>
      new Set(variantes.filter((v) => variantesNoBanco.has(v))),
    upsertContato: async (e) => {
      upserts.push(e);
      if (opcoes.falhaUpsertEm?.includes(e.telefone)) throw new Error("rpc indisponível");
      if (opcoes.upsertNulo) return null;
      return `contato-${upserts.length}`;
    },
    emitirContatoCriado: async (e) => {
      if (opcoes.falhaEmit) throw new Error("emit indisponível");
      emits.push(e.contactId);
    },
    marcarOrigem: async (_org, ids) => {
      if (opcoes.falhaMarca) throw new Error("update indisponível");
      marcados.push(...ids);
    },
    audit: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
  };
  return { deps, offsets, upserts, emits, audits, marcados };
}

async function sincronizar(f: ReturnType<typeof fakeDeps>) {
  return sincronizarAgendaDoCelular(f.deps, {
    organizationId: ORG,
    session: "s1",
    actorUserId: USER,
    requestId: "req-1",
  });
}

describe("candidatoDaAgenda", () => {
  it("só entra quem está SALVO na agenda (isMyContact)", () => {
    expect(candidatoDaAgenda(agenda("5511999990001@c.us", { isMyContact: false }))).toEqual({
      ignorado: "nao_salvo_na_agenda",
    });
    // Marcador ausente é "não sei" — e "não sei" não é convite a importar.
    expect(candidatoDaAgenda(agenda("5511999990001@c.us", { isMyContact: null }))).toEqual({
      ignorado: "nao_salvo_na_agenda",
    });
    expect(candidatoDaAgenda(agenda("5511999990001@c.us"))).toEqual({ telefone: "+5511999990001" });
  });

  it("corta operador, grupo, identidade opaca e quem não tem WhatsApp", () => {
    expect(candidatoDaAgenda(agenda("5511999990001@c.us", { isMe: true }))).toEqual({
      ignorado: "numero_do_operador",
    });
    expect(candidatoDaAgenda(agenda("123456789-1234@g.us"))).toEqual({ ignorado: "nao_e_pessoa" });
    expect(candidatoDaAgenda(agenda("100000000000001@lid"))).toEqual({ ignorado: "nao_e_pessoa" });
    expect(candidatoDaAgenda(agenda("5511999990001@c.us", { isWAContact: false }))).toEqual({
      ignorado: "sem_whatsapp",
    });
  });

  it("rejeita número fora da faixa E.164 e id gigante (campo vem de fora)", () => {
    expect(candidatoDaAgenda(agenda("123@c.us"))).toEqual({ ignorado: "sem_numero_utilizavel" });
    expect(candidatoDaAgenda(agenda(`${"5".repeat(200)}@c.us`))).toEqual({
      ignorado: "sem_numero_utilizavel",
    });
  });
});

describe("sincronizarAgendaDoCelular", () => {
  it("importa o salvo na agenda pelo MESMO upsert do webhook, com nome da agenda", async () => {
    const f = fakeDeps({
      paginas: [[
        agenda("5511999990001@c.us", { name: "Maria da Agenda", pushname: "maria.perfil" }),
        // O lado de fora da régua — cada um por seu motivo, contados e fora.
        agenda("5511999990002@c.us", { isMyContact: false }),
        agenda("5511999990003@c.us", { isMe: true }),
        agenda("123-160000000000@g.us"),
        agenda("5511999990004@c.us", { isWAContact: false }),
      ]],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toEqual({
      lidos: 5,
      importados: 1,
      ja_existentes: 0,
      ignorados: 4,
      erros: 0,
      truncado: false,
    });
    // O MESMO contrato da RPC do webhook: chatId para auditoria, telefone E.164
    // e o nome que a PESSOA salvou (pushname é o fallback, não o contrário).
    expect(f.upserts).toEqual([
      { organizationId: ORG, telefone: "+5511999990001", chatId: "5511999990001@c.us", notify: "Maria da Agenda" },
    ]);
    expect(f.emits).toEqual(["contato-1"]);
  });

  it("pagina até a página curta e soma o que leu", async () => {
    const paginaCheia = Array.from({ length: TAMANHO_DA_PAGINA }, (_, i) =>
      agenda(`5511999${String(i).padStart(7, "0")}@c.us`),
    );
    const f = fakeDeps({ paginas: [paginaCheia, [agenda("5511888880001@c.us"), agenda("5511888880002@c.us")]] });
    const resumo = await sincronizar(f);
    expect(resumo.lidos).toBe(TAMANHO_DA_PAGINA + 2);
    expect(resumo.importados).toBe(TAMANHO_DA_PAGINA + 2);
    expect(resumo.truncado).toBe(false);
    // Offset avança de página em página — sem ele, a segunda chamada releria a
    // primeira. A página CURTA é o fim: não há terceira chamada atrás dela.
    expect(f.offsets).toEqual([0, TAMANHO_DA_PAGINA]);
  });

  it("não duplica: telefone já cadastrado é contado e PULADO (sem upsert)", async () => {
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us"), agenda("5511999990002@c.us")]],
      existentes: ["+5511999990001"],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 1, ja_existentes: 1 });
    expect(f.upserts.map((u) => u.telefone)).toEqual(["+5511999990002"]);
  });

  it("o nono dígito conta: agenda de 12 dígitos acha o contato canônico de 13", async () => {
    // O aparelho salvou o número SEM o 9 (12 dígitos: 55 31 9999 0001); o CRM
    // guarda a forma canônica COM o 9 (55 31 9 9999 0001) — mesma pessoa, e a
    // régua de variantes é o que faz os dois lados se encontrarem.
    const f = fakeDeps({
      paginas: [[agenda("553199990001@c.us")]],
      existentes: ["+5531999990001"],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ ja_existentes: 1, importados: 0 });
    expect(f.upserts).toHaveLength(0);
  });

  it("o MESMO número duas vezes na agenda vira UM contato", async () => {
    // As duas grafias do nono dígito do MESMO celular: 13 dígitos
    // (55 11 9 9999 0001) e a de 12 (55 11 9999 0001).
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us"), agenda("551199990001@c.us")]],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 1, ignorados: 1 });
    expect(f.upserts).toHaveLength(1);
  });

  it("o teto de LEITURA corta a página com truncado — e não vira loop", async () => {
    // Só contatos FORA da agenda: a leitura é que bate no teto, não a importação.
    const foraDaAgenda = () =>
      Array.from({ length: TAMANHO_DA_PAGINA }, (_, i) =>
        agenda(`5511777${String(i).padStart(7, "0")}@c.us`, { isMyContact: false }),
      );
    const paginas = Array.from({ length: TETO_DE_LEITURA / TAMANHO_DA_PAGINA + 5 }, () => foraDaAgenda());
    const f = fakeDeps({ paginas });
    const resumo = await sincronizar(f);
    expect(resumo.lidos).toBe(TETO_DE_LEITURA);
    expect(resumo.truncado).toBe(true);
    expect(f.offsets).toHaveLength(TETO_DE_LEITURA / TAMANHO_DA_PAGINA);
  });

  it("o teto de IMPORTAÇÃO corta em 500 criados e pede para continuar", async () => {
    const paginaCheia = (n: number) =>
      Array.from({ length: TAMANHO_DA_PAGINA }, (_, i) =>
        agenda(`5511666${String(n * 1000 + i).padStart(7, "0")}@c.us`),
      );
    // 6 páginas cheias = 600 candidatos; só 500 são criados nesta passada.
    const f = fakeDeps({ paginas: [0, 1, 2, 3, 4, 5].map((n) => paginaCheia(n)) });
    const resumo = await sincronizar(f);
    expect(resumo.importados).toBe(TETO_DE_IMPORTACOES);
    expect(resumo.truncado).toBe(true);
    expect(f.upserts).toHaveLength(TETO_DE_IMPORTACOES);
  });

  it("a falha de UM contato vira erro nominal e o lote segue", async () => {
    const f = fakeDeps({
      paginas: [[
        agenda("5511999990001@c.us"),
        agenda("5511999990002@c.us"),
        agenda("5511999990003@c.us"),
      ]],
      falhaUpsertEm: ["+5511999990002"],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 2, erros: 1 });
  });

  it("upsert que devolve null conta erro, nunca importado", async () => {
    const f = fakeDeps({ paginas: [[agenda("5511999990001@c.us")]], upsertNulo: true });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 0, erros: 1 });
    expect(f.emits).toHaveLength(0);
  });

  it("o evento contact.created que falha não desfaz a criação nem derruba o lote", async () => {
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us"), agenda("5511999990002@c.us")]],
      falhaEmit: true,
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 2, erros: 0 });
  });

  it("carimba a origem da agenda SÓ em quem nasceu agora (doc 158)", async () => {
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us"), agenda("5511999990002@c.us"), agenda("5511999990003@c.us")]],
      existentes: ["+5511999990002"],
      falhaUpsertEm: ["+5511999990003"],
    });
    await sincronizar(f);
    // O já existente não passa pela RPC, e o que falhou não tem id: só o criado.
    expect(f.marcados).toEqual(["contato-1"]);
  });

  it("o carimbo de origem que falha não desfaz a criação nem derruba o lote", async () => {
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us"), agenda("5511999990002@c.us")]],
      falhaMarca: true,
    });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({ importados: 2, erros: 0 });
    expect(f.audits).toHaveLength(1);
  });

  it("audita o gesto com o resumo inteiro", async () => {
    const f = fakeDeps({ paginas: [[agenda("5511999990001@c.us")]], existentes: ["+5511999990002"] });
    await sincronizar(f);
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({
      action: "contacts.synced_from_phone",
      actorUserId: USER,
      organizationId: ORG,
      resourceType: "contact",
      requestId: "req-1",
      metadata: { lidos: 1, importados: 1, ja_existentes: 0 },
    });
  });

  it("agenda vazia (NOWEB sem store) devolve zeros sem tocar em nada", async () => {
    const f = fakeDeps({ paginas: [[]] });
    const resumo = await sincronizar(f);
    expect(resumo).toEqual({
      lidos: 0,
      importados: 0,
      ja_existentes: 0,
      ignorados: 0,
      erros: 0,
      truncado: false,
    });
    expect(f.upserts).toHaveLength(0);
    expect(f.audits).toHaveLength(1);
  });
});

/** Silencia o logger nestes testes — os avisos de falha são ESPERADOS neles. */
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
