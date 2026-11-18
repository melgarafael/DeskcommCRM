/**
 * POST /api/v1/message-templates/importar — o recorte aditivo do blueprint
 * (issue #1995).
 *
 * O que estes casos provam, e por que nesta forma:
 *
 * 1. Em organização vazia, aplica TODAS as linhas numa operação só, como
 *    compartilhadas (`owner_user_id null`), com mídia vazia e ordem renumerada
 *    pela posição do arquivo — a fração da origem não atravessa.
 * 2. Em organização que já tem resposta compartilhada, responde 409 e NÃO
 *    insere nada. A asserção é na ausência de `insert`, não só no status: uma
 *    rota que recusasse depois de gravar teria o mesmo corpo de erro.
 * 3. O segundo POST do MESMO arquivo cai no mesmo 409 — é a idempotência de
 *    graça do recorte, provada com estado de verdade entre as duas chamadas.
 * 4. DOIS POST SIMULTÂNEOS do mesmo arquivo não podem deixar duas cópias. A
 *    conferência e a gravação são UMA operação (RPC com trava por organização);
 *    o segundo ou espera e cai no 409, ou — se a trava faltar — passa pela
 *    conferência antes do primeiro gravar e duplica. O fake do RPC modela a
 *    transação: a fila por organização É a trava, e a contagem só acontece
 *    depois de a vez chegar.
 * 5. Resposta SÓ DE ÁUDIO não entra. `body` vazio é legal na criação (#2833,
 *    a linha de áudio ganha o arquivo por `POST /:id/midias`), mas o blueprint
 *    NÃO leva mídia: importar o item assim criaria uma resposta sem texto e sem
 *    arquivo. O item fica de fora e a perda é CONTADA (`sem_texto`), na resposta
 *    e no audit — nunca escondida. Arquivo só com itens de áudio é 422: não há
 *    o que aplicar.
 * 6. Cabeçalho errado (formato/versão/tipo) é recusado ANTES dos itens: o
 *    arquivo da versão 2 não pode receber "item inválido" como motivo.
 * 7. Corpo grande é barrado pelo tamanho antes do parser.
 * 8. O audit registra QUANTAS entraram, nunca o conteúdo.
 * 9. Cerca: a função atômica toma a trava POR ORGANIZAÇÃO e o apêndice do
 *    `baseline.sql` é espelho exato da migration — quem aplica só o baseline
 *    (kit self-host) recebe o mesmo SQL que quem aplica migrations.
 */
import { existsSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pedidoComTamanho } from "@/tests/helpers/pedido-com-tamanho";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  marca: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: h.marca }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: h.from, rpc: h.rpc }),
}));

import { POST } from "@/app/api/v1/message-templates/importar/route";
import { FORMATO_DO_BLUEPRINT, TETO_DE_ITENS_DO_BLUEPRINT } from "@/lib/templates/blueprint";

const ORG = "c7d40000-0000-4000-8000-000000000011";
const USER = "c7d40000-0000-4000-8000-000000000012";

const MIGRATION =
  "supabase/migrations/20261102120000_9091_importar_blueprint_uma_vez_por_organizacao.sql";

type Linha = Record<string, unknown>;
type Filtro = { coluna: string; valor: unknown };
type ArgumentosDoRpc = { p_org: string; p_itens: Linha[] };

/**
 * Banco fake com ESTADO, e com os DOIS caminhos:
 *
 *  · `from("message_templates")` — a tabela como o PostgREST a expõe. É o
 *    caminho do defeito: contagem numa requisição HTTP e insert em OUTRA, com a
 *    janela entre as duas. Fica aqui para o caso de concorrência medir a volta
 *    se alguém reintroduzir o par solto.
 *  · `rpc(nome, args)` — a função `fn_importar_blueprint_de_respostas_rapidas`:
 *    conferência e gravação na MESMA transação, serializadas por organização. A
 *    fila do fake é a `pg_advisory_xact_lock` da migration.
 */
function banco(inicial: Linha[] = []) {
  const linhas: Linha[] = inicial.map((linha) => ({ ...linha }));
  const inserts: Linha[][] = [];
  const chamadas: ArgumentosDoRpc[] = [];
  // Uma fila por organização; o teste usa uma, como o caso real usa.
  const filas = new Map<string, Promise<unknown>>();

  function contagem(opcoes?: { count?: string; head?: boolean }) {
    const filtros: Filtro[] = [];
    const q = {
      eq(coluna: string, valor: unknown) {
        filtros.push({ coluna, valor });
        return q;
      },
      is(coluna: string, valor: unknown) {
        filtros.push({ coluna, valor });
        return q;
      },
      then<T>(resolve: (valor: unknown) => T) {
        const casadas = linhas.filter((linha) =>
          filtros.every((f) => linha[f.coluna] === f.valor),
        );
        return Promise.resolve(
          opcoes?.head ? { count: casadas.length, error: null } : { data: casadas, error: null },
        ).then(resolve);
      },
    };
    return q;
  }

  h.from.mockImplementation((tabela: string) => {
    if (tabela !== "message_templates") throw new Error(`tabela inesperada: ${tabela}`);
    return {
      select: (colunas: string, opcoes?: { count?: string; head?: boolean }) =>
        contagem(opcoes),
      insert: (novas: Linha[]) => {
        // A ESCRITA CHEGA DEPOIS de uma ida ao banco: é essa janela que deixa
        // dois POST simultâneos passarem os dois pela conferência.
        return new Promise((resolve) =>
          setTimeout(() => {
            inserts.push(novas);
            linhas.push(...novas);
            resolve({ error: null });
          }, 5),
        );
      },
    };
  });

  h.rpc.mockImplementation(async (nome: string, args: ArgumentosDoRpc) => {
    if (nome !== "fn_importar_blueprint_de_respostas_rapidas") {
      throw new Error(`rpc inesperada: ${nome}`);
    }
    chamadas.push(args);

    const anterior = filas.get(args.p_org) ?? Promise.resolve();
    let liberar!: () => void;
    filas.set(
      args.p_org,
      anterior.then(
        () =>
          new Promise<void>((resolve) => {
            liberar = resolve;
          }),
      ),
    );
    // A TRAVA: quem chega depois espera a transação do primeiro terminar. Sem
    // esta espera, dois POST simultâneos contariam zero e gravariam duas vezes.
    await anterior;
    try {
      // Cede o turno já DENTRO da transação: duas chamadas concorrentes que
      // escapassem da trava chegariam as duas aqui antes do insert.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const ocupada = linhas.some(
        (linha) => linha.organization_id === args.p_org && linha.owner_user_id === null,
      );
      if (ocupada) return { data: { aplicado: false, importadas: 0 }, error: null };

      const novas = args.p_itens.map((item, indice) => ({
        organization_id: args.p_org,
        owner_user_id: null,
        title: item.titulo,
        body: item.corpo,
        shortcut: item.atalho ?? null,
        mostrar_na_barra: item.mostrar_na_barra ?? true,
        ordem: indice,
        midias: [],
      }));
      inserts.push(novas);
      linhas.push(...novas);
      return { data: { aplicado: true, importadas: novas.length }, error: null };
    } finally {
      liberar();
    }
  });

  return { linhas, inserts, chamadas };
}

function blueprint(itens: Linha[], cabecalho: Linha = {}) {
  return {
    // A constante, não o literal: o arquivo e o teste têm de andar juntos.
    formato: FORMATO_DO_BLUEPRINT,
    versao: 1,
    tipo: "respostas_rapidas",
    gerado_em: "2026-10-27T12:00:00.000Z",
    itens,
    ...cabecalho,
  };
}

function pedido(corpo: unknown): Promise<NextRequest> {
  return pedidoComTamanho("http://localhost/api/v1/message-templates/importar", {
    method: "POST",
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  });
  h.apoio.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  // Marca de TERCEIRO de propósito: se a rota voltar a escrever o nome do
  // produto no código, esta asserção não casa — é o que impede a recusa de
  // batizar a instalação do revendedor com a marca da casa.
  h.marca.mockResolvedValue({ nome: "Acme CRM" });
});

describe("POST /message-templates/importar", () => {
  it("aplica em organização vazia como compartilhadas, com mídia vazia e ordem do arquivo", async () => {
    const db = banco();

    const res = await POST(
      await pedido(
        blueprint([
          { titulo: "Boas-vindas", corpo: "Olá!", atalho: "bv", mostrar_na_barra: true },
          // `ordem` forjada no arquivo é ignorada: quem manda é a posição.
          { titulo: "Preço", corpo: "R$ ...", ordem: 137.5 },
        ]),
      ),
    );

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({
      importadas: 2,
      midias_importadas: 0,
      sem_texto: 0,
    });

    // Uma operação só: a rota não toca a tabela por fora do RPC.
    expect(h.from).not.toHaveBeenCalled();
    expect(db.chamadas).toHaveLength(1);

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toEqual([
      {
        organization_id: ORG,
        owner_user_id: null,
        title: "Boas-vindas",
        body: "Olá!",
        shortcut: "bv",
        mostrar_na_barra: true,
        ordem: 0,
        midias: [],
      },
      {
        organization_id: ORG,
        owner_user_id: null,
        title: "Preço",
        body: "R$ ...",
        shortcut: null,
        mostrar_na_barra: true,
        ordem: 1,
        midias: [],
      },
    ]);
  });

  it("organização que já tem compartilhada recusa com 409 e não insere", async () => {
    const db = banco([
      { organization_id: ORG, owner_user_id: null, title: "Já existe", body: "", shortcut: null },
    ]);

    const res = await POST(await pedido(blueprint([{ titulo: "Nova", corpo: "x" }])));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(db.inserts).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("o segundo POST do mesmo arquivo recusa: import não reaplica nem duplica", async () => {
    const db = banco();
    const arquivo = blueprint([
      { titulo: "Uma", corpo: "a" },
      { titulo: "Duas", corpo: "b" },
    ]);

    const primeira = await POST(await pedido(arquivo));
    const segunda = await POST(await pedido(arquivo));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(409);
    // Duas linhas no banco, um insert: nada foi duplicado nem sobrescrito.
    expect(db.linhas).toHaveLength(2);
    expect(db.inserts).toHaveLength(1);
  });

  it("dois POST SIMULTÂNEOS deixam UMA cópia: o segundo recebe 409", async () => {
    const db = banco();
    const arquivo = blueprint([
      { titulo: "Uma", corpo: "a" },
      { titulo: "Duas", corpo: "b" },
      { titulo: "Três", corpo: "c" },
    ]);

    // Sem `await` entre os dois: é a corrida de verdade. Sem a operação única,
    // os dois passam pela conferência antes de qualquer escrita aparecer.
    const [a, b] = await Promise.all([POST(await pedido(arquivo)), POST(await pedido(arquivo))]);

    // A MEDIÇÃO primeiro: é o número que o defeito move (6 linhas em vez de 3
    // quando os dois POST passam). Três linhas, UM insert.
    expect(db.linhas).toHaveLength(3);
    expect(db.inserts).toHaveLength(1);

    const estados = [a.status, b.status].sort();
    // DECLARADO: o segundo NÃO entra como no-op silencioso — recebe o mesmo 409
    // de "esta organização já tem respostas rápidas compartilhadas".
    expect(estados).toEqual([201, 409]);
    const perdedor = a.status === 409 ? a : b;
    expect((await perdedor.json()).error.code).toBe("state_conflict");

    // As duas chamadas chegaram à função — a segunda esperou a trava e viu a
    // organização já ocupada (não foi barrada antes do banco por acaso).
    expect(db.chamadas).toHaveLength(2);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("resposta só de áudio não entra no destino e é contada em `sem_texto`", async () => {
    const db = banco();

    const res = await POST(
      await pedido(
        blueprint([
          { titulo: "Uma", corpo: "a" },
          { titulo: "Duas", corpo: "b" },
          { titulo: "Três", corpo: "c" },
          { titulo: "Quatro", corpo: "d" },
          { titulo: "Cinco", corpo: "e" },
          // Recurso de ÁUDIO na origem: linha sem texto, com o arquivo em
          // `midias` — que o blueprint não leva (o caminho é de outra org).
          { titulo: "Áudio do consultório", corpo: "   ", atalho: "aud" },
        ]),
      ),
    );

    // O destino recebe 5, não 6: o item de áudio não vira linha vazia.
    expect(db.linhas).toHaveLength(5);
    expect(db.linhas.filter((linha) => linha.body === "" || String(linha.body).trim() === "")).toEqual(
      [],
    );
    expect(db.linhas.some((linha) => linha.title === "Áudio do consultório")).toBe(false);

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({
      importadas: 5,
      midias_importadas: 0,
      // A perda é DECLARADA, não escondida.
      sem_texto: 1,
    });

    // A ordem fecha 0..4 sem buraco: o item de áudio não deixa posição vazia.
    expect(db.linhas.map((linha) => linha.ordem)).toEqual([0, 1, 2, 3, 4]);
  });

  it("arquivo SÓ com itens de áudio é 422: não há o que aplicar", async () => {
    const db = banco();

    const res = await POST(
      await pedido(
        blueprint([
          { titulo: "Áudio 1", corpo: "" },
          { titulo: "Áudio 2", corpo: "   " },
        ]),
      ),
    );

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toMatch(/áudio/);
    expect(corpo.error.details).toEqual({ sem_texto: 2 });
    expect(db.chamadas).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("arquivo de outra versão diz a versão, e não 'item inválido'", async () => {
    const db = banco();

    const res = await POST(await pedido(blueprint([{ titulo: "x", corpo: "y" }], { versao: 2 })));

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toMatch(/versão/);
    expect(db.inserts).toHaveLength(0);
  });

  it("arquivo que não é blueprint e blueprint de outro tipo são recusados", async () => {
    const db = banco();

    const naoEhBlueprint = await POST(await pedido({ itens: [{ titulo: "x" }] }));
    expect(naoEhBlueprint.status).toBe(422);
    const recusa = await naoEhBlueprint.json();
    expect(recusa.error.message).toMatch(/não é um blueprint/);
    // A recusa cita a marca RESOLVIDA da organização — nem literal no código,
    // nem nome da instalação quando o revendedor tem o dele.
    expect(recusa.error.message).toContain("Acme CRM");
    expect(h.marca).toHaveBeenCalledWith(ORG);

    const outroTipo = await POST(await pedido(blueprint([{ titulo: "x" }], { tipo: "funis_e_etapas" })));
    expect(outroTipo.status).toBe(422);
    expect((await outroTipo.json()).error.message).toMatch(/não é de respostas rápidas/);
    // Só a recusa de formato paga a leitura da marca.
    expect(h.marca).toHaveBeenCalledTimes(1);

    expect(db.inserts).toHaveLength(0);
  });

  it("item fora dos limites do POST é recusado sem inserir nada", async () => {
    const db = banco();

    const res = await POST(await pedido(blueprint([{ titulo: "t".repeat(81), corpo: "x" }])));

    expect(res.status).toBe(422);
    expect(db.inserts).toHaveLength(0);
  });

  it("lista acima do teto é recusada com a frase que cita o limite, sem inserir", async () => {
    const db = banco();
    const itens = Array.from({ length: TETO_DE_ITENS_DO_BLUEPRINT + 1 }, (_, i) => ({
      titulo: `R${i}`,
      corpo: "x",
    }));

    const res = await POST(await pedido(blueprint(itens)));

    expect(res.status).toBe(422);
    // A frase leva o número do teto: quem tem 201 respostas lê a causa certa.
    expect((await res.json()).error.message).toContain(`de 1 a ${TETO_DE_ITENS_DO_BLUEPRINT}`);
    expect(db.inserts).toHaveLength(0);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("lista vazia não é blueprint: nada a aplicar", async () => {
    const db = banco();

    const res = await POST(await pedido(blueprint([])));

    expect(res.status).toBe(422);
    expect(db.inserts).toHaveLength(0);
  });

  it("corpo que não é JSON é 400 e arquivo grande é 413", async () => {
    const db = banco();

    const invalido = await POST(await pedido("isto não é json"));
    expect(invalido.status).toBe(400);
    expect((await invalido.json()).error.code).toBe("invalid_request");

    const grande = await POST(await pedido(" ".repeat(2 * 1024 * 1024 + 1)));
    expect(grande.status).toBe(413);
    expect((await grande.json()).error.code).toBe("payload_too_large");

    expect(db.inserts).toHaveLength(0);
  });

  it("o tamanho declarado acima de 2 MB é 413 antes de ler o corpo", async () => {
    const db = banco();
    // Corpo pequeno e válido, cabeçalho declarando mais que o teto: o único
    // jeito de este pedido dar 413 é a rota olhar o cabeçalho antes de ler.
    const req = new NextRequest("http://localhost/api/v1/message-templates/importar", {
      method: "POST",
      body: JSON.stringify(blueprint([{ titulo: "x", corpo: "y" }])),
      headers: {
        "Content-Type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      },
    });

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(db.inserts).toHaveLength(0);
  });

  it("a guarda de apoio barra antes de qualquer leitura do banco", async () => {
    h.apoio.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "forbidden_scope" } }), { status: 403 }),
    );

    const res = await POST(await pedido(blueprint([{ titulo: "x" }])));

    expect(res.status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("o audit conta o que entrou — e o que ficou de fora — sem guardar conteúdo", async () => {
    banco();

    await POST(
      await pedido(
        blueprint([
          { titulo: "Script interno", corpo: "texto sensível" },
          { titulo: "Áudio", corpo: "" },
        ]),
      ),
    );

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template.imported",
        organizationId: ORG,
        resourceType: "message_template",
        metadata: expect.objectContaining({ total: 1, midias_importadas: 0, sem_texto: 1 }),
      }),
    );
    const registrado = JSON.stringify(h.audit.mock.calls[0]?.[0]);
    expect(registrado).not.toContain("Script interno");
    expect(registrado).not.toContain("texto sensível");
  });
});

describe("a operação do import é atômica — e o baseline a espelha", () => {
  it("a migration existe, toma a trava POR ORGANIZAÇÃO e grava na mesma função", () => {
    // Controle: sem o arquivo, o `readFileSync` estouraria — nunca um verde mudo.
    expect(existsSync(MIGRATION)).toBe(true);
    const sql = readFileSync(MIGRATION, "utf8");

    expect(sql).toContain("create or replace function public.fn_importar_blueprint_de_respostas_rapidas");
    // A trava é por ORGANIZAÇÃO: nem por ator, nem pelo arquivo — duas pessoas
    // importando ao mesmo tempo disputam o mesmo recurso.
    expect(sql).toMatch(/pg_advisory_xact_lock\(\s*hashtextextended\(\s*p_org/);
    // A conferência e a escrita estão DENTRO da função: é o que as põe na
    // mesma transação (e portanto sob a mesma trava).
    expect(sql).toContain("insert into public.message_templates");
    expect(sql).toMatch(/perform pg_advisory_xact_lock[\s\S]*insert into public\.message_templates/);
  });

  it("o apêndice do baseline.sql é espelho exato da migration", () => {
    expect(existsSync("supabase/baseline.sql")).toBe(true);
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline.includes(readFileSync(MIGRATION, "utf8"))).toBe(true);
  });
});
