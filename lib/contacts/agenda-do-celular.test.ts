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
  /** Gravar o nome da agenda falha — idem: o contato já existe. */
  falhaNome?: boolean;
} = {}) {
  const paginas = opcoes.paginas ?? [[]];
  const variantesNoBanco = new Set((opcoes.existentes ?? []).flatMap(phoneLookupVariants));
  const offsets: number[] = [];
  const upserts: Array<{ telefone: string; chatId: string; notify: string | null }> = [];
  const emits: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const marcados: string[] = [];
  const nomes: Array<{ contactId: string; nome: string }> = [];
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
      // A RPC grava de verdade: o telefone criado EXISTE no próximo clique.
      // Sem isto o dublê mentiria que todo clique reencontra um banco vazio, e
      // a retomada (que depende de "já existente" ser barato) não seria medida.
      for (const v of phoneLookupVariants(e.telefone)) variantesNoBanco.add(v);
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
    gravarNomeDaAgenda: async (_org, contactId, nome) => {
      if (opcoes.falhaNome) throw new Error("update indisponível");
      nomes.push({ contactId, nome });
    },
    audit: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
  };
  return { deps, offsets, upserts, emits, audits, marcados, nomes };
}

async function sincronizar(f: ReturnType<typeof fakeDeps>, offset = 0) {
  return sincronizarAgendaDoCelular(f.deps, {
    organizationId: ORG,
    session: "s1",
    actorUserId: USER,
    requestId: "req-1",
    offset,
  });
}

/**
 * O item CRU do `GET /api/contacts/all` no motor NOWEB (o padrão do kit):
 * o `toWAContact` de lá monta `{id, lid, name, notify, verifiedName, imgUrl,
 * status}` — SEM `isMyContact`. Aqui ele é normalizado como o cliente faz:
 * `name` e `pushname` (o cliente lê `pushname`/`pushName`), e o marcador
 * ausente vira `null` (`c.isMyContact ?? null`). O `notify` do NOWEB é o
 * apelido do PERFIL — mesmo papel do `pushname`, e NÃO é prova de agenda.
 */
function doNoweb(cru: {
  id: string;
  lid?: string;
  name?: string | null;
  notify?: string | null;
  pushname?: string | null;
}): ContatoDoAparelho {
  return {
    id: cru.id,
    name: cru.name ?? null,
    pushname: cru.pushname ?? null,
    isMyContact: null,
    isWAContact: null,
    isMe: null,
  };
}

describe("candidatoDaAgenda", () => {
  it("os três estados de \"salvo na agenda\": WEBJS explícito e NOWEB pelo `name`", () => {
    // (d) WEBJS: `isMyContact === true` importa — o caso que já funcionava.
    expect(candidatoDaAgenda(agenda("5511999990001@c.us"))).toEqual({ telefone: "+5511999990001" });
    // (c) WEBJS: `isMyContact === false` NÃO importa — o marcador explícito manda.
    expect(candidatoDaAgenda(agenda("5511999990001@c.us", { isMyContact: false }))).toEqual({
      ignorado: "nao_salvo_na_agenda",
    });
    // (a) NOWEB: sem o marcador, o `name` (o nome SALVO no celular) é a prova.
    expect(
      candidatoDaAgenda(
        doNoweb({ id: "5511999990001@c.us", lid: "100000000000001@lid", name: "Maria da Agenda", notify: "maria.perfil" }),
      ),
    ).toEqual({ telefone: "+5511999990001" });
    // (b) NOWEB SEM `name`: só pushname/notify descreve o PERFIL — não está na agenda.
    expect(candidatoDaAgenda(doNoweb({ id: "5511999990002@c.us", notify: "jose.perfil" }))).toEqual({
      ignorado: "nao_salvo_na_agenda",
    });
    // `name` só com espaços não é nome salvo: o trim decide.
    expect(candidatoDaAgenda(doNoweb({ id: "5511999990003@c.us", name: "   " }))).toEqual({
      ignorado: "nao_salvo_na_agenda",
    });
    // `isMyContact: false` com `name` continua fora: quem está fora da agenda
    // não entra só porque o nome veio preenchido.
    expect(
      candidatoDaAgenda(agenda("5511999990004@c.us", { isMyContact: false, name: "Quem não foi salvo" })),
    ).toEqual({ ignorado: "nao_salvo_na_agenda" });
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
      proximo_offset: null,
    });
    // O MESMO contrato da RPC do webhook: chatId para auditoria, telefone E.164
    // e o apelido do PERFIL — o mesmo dado que a mensagem traria.
    expect(f.upserts).toEqual([
      { organizationId: ORG, telefone: "+5511999990001", chatId: "5511999990001@c.us", notify: "maria.perfil" },
    ]);
    expect(f.emits).toEqual(["contato-1"]);
  });

  it("NOWEB (sem `isMyContact`): importa pelo `name` da agenda e descarta quem só tem perfil", async () => {
    const f = fakeDeps({
      paginas: [[
        // A forma do NOWEB, o motor padrão do kit: `name` = salvo no celular.
        doNoweb({ id: "5511999990001@c.us", lid: "100000000000001@lid", name: "Maria da Agenda", notify: "maria.perfil" }),
        // O mesmo motor, sem `name`: só o apelido do PERFIL (notify/pushname).
        doNoweb({ id: "5511999990002@c.us", notify: "jose.perfil" }),
      ]],
    });
    const resumo = await sincronizar(f);
    expect(resumo).toEqual({
      lidos: 2,
      importados: 1,
      ja_existentes: 0,
      ignorados: 1,
      erros: 0,
      truncado: false,
      proximo_offset: null,
    });
    // Só o que tem nome SALVO no celular chega ao upsert — e o nome da agenda
    // vai para o campo da equipe.
    expect(f.upserts.map((u) => u.chatId)).toEqual(["5511999990001@c.us"]);
    expect(f.nomes).toEqual([{ contactId: "contato-1", nome: "Maria da Agenda" }]);
  });

  it("o nome salvo na agenda vai para o campo da equipe, nunca para o nome que o cliente vê (#2439)", async () => {
    const f = fakeDeps({
      paginas: [[
        agenda("5511999990001@c.us", { name: "João obra", pushname: "joao" }),
        // Agenda sem nome de gente (só o número) não grava nada.
        agenda("5511999990002@c.us", { name: "+55 11 99999-0002" }),
      ]],
    });
    await sincronizar(f);
    expect(f.upserts.map((u) => u.notify)).toEqual(["joao", null]);
    expect(f.nomes).toEqual([{ contactId: "contato-1", nome: "João obra" }]);
  });

  it("o nome da agenda que falha ao gravar não desfaz a criação nem derruba o lote", async () => {
    const f = fakeDeps({
      paginas: [[agenda("5511999990001@c.us", { name: "Ana" }), agenda("5511999990002@c.us", { name: "Bia" })]],
      falhaNome: true,
    });
    const resumo = await sincronizar(f);
    expect(resumo.importados).toBe(2);
    expect(resumo.erros).toBe(0);
    expect(f.emits).toEqual(["contato-1", "contato-2"]);
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

  it("o teto de LEITURA corta a página com truncado e devolve o cursor — e não vira loop", async () => {
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
    // Nada foi gravado, então o cursor é o fim da leitura: o próximo clique
    // começa na linha 1.000, e não na zero.
    expect(resumo.proximo_offset).toBe(TETO_DE_LEITURA);
  });

  it("o teto de IMPORTAÇÃO corta em 500 criados e o cursor é a linha do primeiro NÃO gravado", async () => {
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
    // O 501º candidato veio da linha 500 da agenda: é AQUI que o próximo clique
    // recomeça. Devolver o fim da leitura (600) pularia 100 contatos para sempre.
    expect(resumo.proximo_offset).toBe(TETO_DE_IMPORTACOES);
  });

  it("agenda dublê de 1.500 salvos: cada clique retoma no anterior, os 1.500 entram e o último fecha sem truncado", async () => {
    const TOTAL = 1500;
    // A agenda do aparelho: 15 páginas de 100, todas SALVAS e com WhatsApp. É a
    // agenda que o mantenedor mediu em 16/10 — quatro cliques importavam
    // 500, 500, 0 e 0, e os 500 depois do milésimo nunca entravam.
    const paginas = Array.from({ length: TOTAL / TAMANHO_DA_PAGINA }, (_, p) =>
      Array.from({ length: TAMANHO_DA_PAGINA }, (_, i) =>
        agenda(`5511${String(p * TAMANHO_DA_PAGINA + i).padStart(8, "0")}@c.us`),
      ),
    );
    const f = fakeDeps({ paginas });

    type Clique = {
      offset: number;
      lidos: number;
      importados: number;
      ja_existentes: number;
      truncado: boolean;
      proximo_offset: number | null;
    };
    // O que a TELA faz: o `proximo_offset` do resumo vira o offset do clique
    // seguinte. Nada aqui adivinha de onde continuar.
    const cliques: Clique[] = [];
    let offset = 0;
    for (let n = 1; ; n += 1) {
      const r = await sincronizar(f, offset);
      cliques.push({
        offset,
        lidos: r.lidos,
        importados: r.importados,
        ja_existentes: r.ja_existentes,
        truncado: r.truncado,
        proximo_offset: r.proximo_offset,
      });
      const numeros = JSON.stringify(cliques, null, 0);
      if (!r.truncado) break;
      // Clique que corta e não grava nada é a rodinha girando: o cursor não
      // avançou. Falha com os números de CADA clique no log.
      expect(r.importados, `cliques: ${numeros}`).toBeGreaterThan(0);
      expect(r.proximo_offset, `cliques: ${numeros}`).not.toBeNull();
      offset = r.proximo_offset as number;
      // 1.500 / 500 = 3 passadas; a folga é para o teste nunca entrar em laço.
      expect(n, `cliques: ${numeros}`).toBeLessThan(6);
    }

    // A TABELA dos cliques, medida: cada passada começa onde a anterior parou,
    // grava 500, e o último fecha a conta (truncado false, sem cursor).
    expect(cliques).toEqual([
      { offset: 0, lidos: 1000, importados: 500, ja_existentes: 0, truncado: true, proximo_offset: 500 },
      { offset: 500, lidos: 1000, importados: 500, ja_existentes: 0, truncado: true, proximo_offset: 1000 },
      { offset: 1000, lidos: 500, importados: 500, ja_existentes: 0, truncado: false, proximo_offset: null },
    ]);
    // Os 1.500 entraram UMA vez cada — sem repetir e sem parar no milésimo.
    expect(f.upserts).toHaveLength(TOTAL);
    expect(new Set(f.upserts.map((u) => u.telefone)).size).toBe(TOTAL);
    // A 11ª leitura (a primeira do SEGUNDO clique) é a linha 500, não a zero:
    // é isto que faltava e que deixava os 500 do fim inalcançáveis.
    expect(f.offsets.slice(0, 11)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 500]);
  });

  it("agenda pequena (12 salvos) resolve em UM clique, sem cursor pendente", async () => {
    const paginas = [
      Array.from({ length: 12 }, (_, i) => agenda(`5511555${String(i).padStart(7, "0")}@c.us`)),
    ];
    const f = fakeDeps({ paginas });
    const resumo = await sincronizar(f);
    expect(resumo).toMatchObject({
      lidos: 12,
      importados: 12,
      ja_existentes: 0,
      truncado: false,
      proximo_offset: null,
    });
    // Uma página só, uma leitura só: nada a retomar.
    expect(f.offsets).toEqual([0]);
    expect(f.upserts).toHaveLength(12);
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
      proximo_offset: null,
    });
    expect(f.upserts).toHaveLength(0);
    expect(f.audits).toHaveLength(1);
  });
});

/** Silencia o logger nestes testes — os avisos de falha são ESPERADOS neles. */
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
