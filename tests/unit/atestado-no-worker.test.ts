// @vitest-environment node
/**
 * O ATESTADO NO WORKER — a ordem, o escopo da falha, a guarda do país e o que a CÓPIA
 * GRAVADA carrega.
 *
 * ─── Por que asserção de FONTE E medição de COMPORTAMENTO no mesmo arquivo ───────────────────
 *
 * As asserções de fonte são a mesma técnica de `lgpd-aviso-apos-apagar.test.ts` para a ORDEM do
 * worker (ler o endereço ANTES da cascata, emitir DEPOIS): a ordem é o que a cascata destrói (o
 * passo 1 zera `email`, `display_name` e `phone_number`), e o que se quer travar é o CONTRATO que
 * uma refatoração descuidada quebra em silêncio. O invariante de banco
 * (`tests/invariants/lgpd-aviso-do-artigo-12-so-fora-do-brasil.test.ts`) mede o mesmo caminho com
 * Postgres, e continua sendo a prova canônica de banco.
 *
 * O COMPORTAMENTO é medido aqui, com o worker REAL e um dublê de banco, porque os itens do CR do
 * PR #3321 que mexem no documento só se provam OLHANDO O QUE FOI GRAVADO:
 *
 *   1. `avisaTitular` (a guarda do país) governa o atestado E a leitura do contato — provado nos
 *      DOIS sentidos: Portugal lê e grava o papel; o Brasil não lê contato nenhum e não grava papel.
 *   2. A cópia do Storage não carrega dado reidentificável do titular. O dublê planta a identidade
 *      que a anonimização apaga (nome, e-mail, telefone e CPF, no contato E no payload do pedido) e
 *      o caso EXTRAI O TEXTO DAS BYTES GRAVADAS. "Não contém" só vale com controle positivo na
 *      MESMA rodada: sem ele, extração morta e documento limpo são indistinguíveis.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { PerfilDoPais } from "@/lib/legal/perfil-do-pais";

/** Os valores que a anonimização APAGA — plantados no contato e no payload do pedido. */
const PII = {
  nome: "Maria Souza",
  email: "maria@exemplo.com",
  telefone: "+55 11 98888-7777",
  cpf: "529.982.247-25",
} as const;

const ORG = "0657c000-0000-4000-8000-000000000009";
const PEDIDO = "0657c000-2222-4000-8000-000000000009";
const CONTATO = "0657c000-1111-4000-8000-000000000009";

/**
 * O dublê de banco e o diário da execução. Mora em `vi.hoisted` porque as fábricas de `vi.mock`
 * são içadas acima dos imports — variável de escopo comum daria `Cannot access before
 * initialization`.
 */
const h = vi.hoisted(() => {
  const estado = {
    /** O país que `perfilDaOrganizacao` responde: `PT` avisa (e emite), `BR` não. */
    pais: "PT",
    /** O encarregado no cadastro da organização (`organizations.dpo_email`). */
    dpoDaOrganizacao: "dpo@loja.exemplo" as string | null,
    /** O piso da instalação (`LGPD_DPO_EMAIL`), o mesmo do relatório do art. 18, II. */
    dpoDaInstalacao: null as string | null,
    /** O que existe na linha do contato no momento da leitura — o endereço do aviso. */
    contatoEmail: "" as string | null,
    /** Tudo que o worker fez, na ORDEM: é assim que a ordem vira asserção de comportamento. */
    eventos: [] as string[],
    /** Os uploads no Storage, com as BYTES gravadas. */
    uploads: [] as Array<{ bucket: string; path: string; corpo: Buffer }>,
    /** Os `update` em `lgpd_requests`, na ordem — é onde o `result.atestado` aparece. */
    atualizacoes: [] as Array<Record<string, unknown>>,
  };

  /** O mínimo do cliente admin que o caminho do worker usa: `from/select/eq/update/rpc/storage`. */
  function criar() {
    const respostaPorTabela: Record<string, { data: unknown; error: unknown }> = {
      contacts: { data: { email: estado.contatoEmail }, error: null },
      organizations: {
        data: {
          legal_name: "Loja Exemplo LTDA",
          display_name: "Loja Exemplo",
          cnpj: "12.345.678/0001-90",
          dpo_email: estado.dpoDaOrganizacao,
          timezone: "America/Sao_Paulo",
        },
        error: null,
      },
      lgpd_requests: { data: null, error: null },
    };
    return {
      from(tabela: string) {
        const resposta = () => respostaPorTabela[tabela] ?? { data: null, error: null };
        const cadeia: Record<string, unknown> = {
          select: (colunas?: string) => {
            estado.eventos.push(`select:${tabela}:${colunas ?? ""}`);
            return cadeia;
          },
          eq: () => cadeia,
          update: (payload: Record<string, unknown>) => {
            estado.eventos.push(`update:${tabela}`);
            if (tabela === "lgpd_requests") estado.atualizacoes.push(payload);
            return cadeia;
          },
          insert: () => cadeia,
          maybeSingle: async () => resposta(),
          single: async () => resposta(),
          // `await admin.from(...).update(...).eq(...).eq(...)` — a cadeia é thenable.
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(res, rej),
        };
        return cadeia;
      },
      rpc: async () => {
        estado.eventos.push("rpc");
        return { data: null, error: null };
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, corpo: Buffer) => {
            estado.eventos.push("upload");
            estado.uploads.push({ bucket, path, corpo });
            return { error: null };
          },
        }),
      },
    };
  }

  return { estado, criar };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.criar() }));
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: vi.fn(async () => ({ valor: h.estado.dpoDaInstalacao })),
}));
vi.mock("@/lib/legal/perfil-do-pais", async (orig) => {
  const real = await orig<typeof import("@/lib/legal/perfil-do-pais")>();
  // O país vem do PERFIL REAL do repositório; só a leitura da coluna é substituída.
  return {
    ...real,
    perfilDaOrganizacao: vi.fn(async (): Promise<PerfilDoPais> => real.perfilDoPais(h.estado.pais)),
  };
});
vi.mock("@/lib/lgpd/repository", () => ({
  findLgpdRequest: vi.fn(async () => ({
    id: PEDIDO,
    organization_id: ORG,
    request_type: "redact",
    status: "received",
    attempts: 0,
    contact_id: CONTATO,
    external_customer_id: null,
    scope: "contact",
    received_at: "2026-09-10T12:00:00.000Z",
    due_at: "2026-10-05T00:00:00.000Z",
    // O pedido que chega pela plataforma traz a identidade junto: era por AQUI
    // que o documento antigo também podia reimprimir o titular.
    request_payload: {
      nome: PII.nome,
      email: PII.email,
      telefone: PII.telefone,
      cpf: PII.cpf,
      execucao: {
        origem: "aprovacao_manual",
        executor: { user_id: "u1", nome: "Ana Lima", email: "ana@loja.test", papel: "administrador" },
        ip: "203.0.113.7",
        em: "2026-10-22T15:04:05.000Z",
      },
    },
  })),
  findContactByExternalId: vi.fn(async () => null),
}));
vi.mock("@/lib/lgpd/redact-cascade", () => ({
  cascadeRedactContact: vi.fn(async () => {
    h.estado.eventos.push("cascade");
    return { alreadyAnonymized: false, counts: { contacts: 1, conversations: 0, messages: 0 }, mediaPaths: [] };
  }),
}));
vi.mock("@/lib/lgpd/aviso-apos-apagar", () => ({
  avisarTitularAposApagamento: vi.fn(async () => {
    h.estado.eventos.push("aviso");
    return { enviado: true, motivo: null, mensagemId: "m1" };
  }),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {
    h.estado.eventos.push("audit");
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { BUCKET_DO_ATESTADO } from "@/lib/lgpd/emitir-atestado";
import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

const fonte = readFileSync(join(process.cwd(), "workers", "lgpd-redact-worker.ts"), "utf8");
const rotaAprovar = readFileSync(
  join(process.cwd(), "app", "api", "v1", "lgpd", "requests", "[id]", "approve", "route.ts"),
  "utf8",
);
const rotaAtestado = readFileSync(
  join(process.cwd(), "app", "api", "v1", "lgpd", "requests", "[id]", "atestado", "route.ts"),
  "utf8",
);

const leitura = fonte.indexOf('from("contacts")');
const cascata = fonte.indexOf("cascadeRedactContact({");
const emissao = fonte.indexOf("emitirAtestadoDeAnonimizacao(admin");

function evento(): EventRow {
  return {
    id: "0657c000-3333-4000-8000-000000000009",
    organization_id: ORG,
    event_type: "lgpd.redact_received",
    entity_kind: "lgpd_request",
    entity_id: PEDIDO,
    payload: { request_id: PEDIDO, scope: "contact" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  } as EventRow;
}

/** O `result` como o worker o gravou (o ÚLTIMO `update` de `lgpd_requests` com `result`). */
function resultadoGravado(): Record<string, unknown> {
  const comResult = h.estado.atualizacoes.filter((a) => "result" in a);
  expect(comResult.length, "o worker não gravou o resultado do pedido").toBeGreaterThan(0);
  return comResult.at(-1)!.result as Record<string, unknown>;
}

beforeEach(() => {
  h.estado.pais = "PT";
  h.estado.dpoDaOrganizacao = "dpo@loja.exemplo";
  h.estado.dpoDaInstalacao = null;
  h.estado.contatoEmail = PII.email;
  h.estado.eventos.length = 0;
  h.estado.uploads.length = 0;
  h.estado.atualizacoes.length = 0;
});

describe("a ordem no worker", () => {
  it("lê o endereço do contato ANTES da cascata — e SÓ o endereço", () => {
    expect(leitura, "o worker não lê mais o contato").toBeGreaterThan(-1);
    expect(leitura, "a leitura do contato saiu de antes da cascata").toBeLessThan(cascata);
    // O atestado deixou de ler identidade (item 1 do CR): nome, telefone e
    // `custom_fields` não têm mais consumidor, e ler "por via das dúvidas" seria
    // carregar PII do titular por um caminho que não a usa.
    expect(fonte).toContain('.select("email")');
    expect(fonte).not.toContain('.select("email, display_name, phone_number, custom_fields, cpf_hash")');
  });

  it("emite o atestado DEPOIS da cascata — nunca antes do apagamento", () => {
    expect(emissao, "o worker não emite mais o atestado").toBeGreaterThan(-1);
    expect(
      emissao,
      "o atestado passou a ser emitido antes da cascata: o papel diria que apagou sem ter apagado",
    ).toBeGreaterThan(cascata);
  });

  it("o atestado entra no RESULTADO do pedido, não num log perdido", () => {
    expect(fonte).toContain("...(atestadoDoPedido ? { atestado: atestadoDoPedido } : {}),");
  });

  it("a falha do papel NÃO derruba o pedido: fica em `result.atestado.erro` e no log", () => {
    expect(fonte).toContain("atestadoDoPedido = { erro: motivo };");
    expect(fonte).toContain('logger.warn("lgpd: atestado de anonimização não emitido"');
    // A emissão tem de estar DENTRO do try: emitir fora dele devolveria a falha
    // ao dispatcher e o pedido do titular viraria `failed` por causa do papel.
    const tryAntes = fonte.lastIndexOf("try {", emissao);
    expect(tryAntes, "a emissão do atestado saiu de dentro do try").toBeGreaterThan(-1);
    const catchDepois = fonte.indexOf("catch (erroDoAtestado)", emissao);
    expect(catchDepois, "a emissão perdeu o catch").toBeGreaterThan(emissao);
  });

  it("o aviso do art. 12.º continua com a guarda do país — o atestado não a desfez", () => {
    expect(fonte).toContain("const avisaTitular = exclusaoForaDoBrasil(req.request_type, perfil.codigo);");
  });

  it("a guarda do país precede a leitura do contato E a emissão do papel (item 3 do CR)", () => {
    const guarda = fonte.indexOf("const avisaTitular = exclusaoForaDoBrasil(req.request_type, perfil.codigo);");
    const condicionada = fonte.indexOf("if (avisaTitular) {");
    expect(guarda).toBeGreaterThan(-1);
    expect(condicionada, "nem a leitura nem a emissão estão atrás de `avisaTitular`").toBeGreaterThan(guarda);
    expect(condicionada).toBeLessThan(leitura);
    expect(condicionada).toBeLessThan(emissao);
  });
});

describe("o atestado NÃO cita lei (item 2 do CR)", () => {
  it("a citação do direito de acesso saiu do worker", () => {
    // `citacaoDaLei(perfil)` devolve `LGPD Art. 18, II` no Brasil e `RGPD art.
    // 15.º` em Portugal — direito de ACESSO, não de eliminação.
    expect(fonte, "o worker voltou a citar lei no atestado").not.toContain("citacaoDaLei");
    expect(fonte).not.toContain("lei_citada");
    expect(fonte).not.toContain("lei_rotulo");
  });
});

describe("a guarda do país governa o atestado e a leitura do contato — os DOIS sentidos", () => {
  it("Portugal (avisa): lê o endereço antes da cascata, emite e grava o papel", async () => {
    h.estado.pais = "PT";

    const resultado = await processLgpdRedact(evento());

    expect(resultado.status).toBe("ok");
    // A leitura do contato aconteceu — e ANTES da cascata.
    expect(h.estado.eventos).toContain("select:contacts:email");
    expect(h.estado.eventos.indexOf("select:contacts:email")).toBeLessThan(h.estado.eventos.indexOf("cascade"));
    // E o papel foi gravado no bucket do titular, uma vez.
    expect(h.estado.uploads).toHaveLength(1);
    expect(h.estado.uploads[0]!.bucket).toBe(BUCKET_DO_ATESTADO);
    expect(h.estado.uploads[0]!.path).toBe(`${ORG}/${PEDIDO}/atestado.pdf`);
    // O resultado do pedido declara o papel (código + hash) e o aviso. O
    // algoritmo NÃO é fixado aqui: sem `LGPD_SIGNING_KEY` no ambiente do teste a
    // instalação degrada para SHA-256 (o caso que existe é o papel sair), e o
    // caso do algoritmo é medido em `atestado-de-anonimizacao-emissao.test.ts`.
    const result = resultadoGravado();
    expect(result.atestado).toMatchObject({
      algoritmo: expect.stringMatching(/^(hmac-)?sha256$/),
      codigo_curto: expect.stringMatching(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.art12_notice).toBe("sent");
  });

  it("Brasil (não avisa): NENHUMA leitura de contato, NENHUM upload e nenhum `atestado` no resultado", async () => {
    h.estado.pais = "BR";

    const resultado = await processLgpdRedact(evento());

    expect(resultado.status).toBe("ok");
    // Nenhuma leitura da tabela de contatos: o único consumidor que restou era o
    // endereço do aviso, e no Brasil ele não existe.
    expect(h.estado.eventos.filter((e) => e.startsWith("select:contacts"))).toEqual([]);
    expect(h.estado.uploads).toEqual([]);
    // Ausência de CHAVE, não de valor: é o que mantém o Brasil igual à main.
    const result = resultadoGravado();
    expect(Object.prototype.hasOwnProperty.call(result, "atestado")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "art12_notice")).toBe(false);
    // Prova de vacuidade: a cascata ACONTECEU — o que não aconteceu foi o papel.
    expect(h.estado.eventos).toContain("cascade");
    expect(result).toMatchObject({ contact_id: CONTATO });
  });
});

describe("a cópia GRAVADA no Storage não carrega o que a anonimização apagou (item 1 do CR)", () => {
  it("as bytes gravadas identificam o pedido pelo protocolo — e não trazem o titular", async () => {
    h.estado.pais = "PT";

    await processLgpdRedact(evento());

    expect(h.estado.uploads).toHaveLength(1);
    const texto = await extractPdfText(h.estado.uploads[0]!.corpo);

    // CONTROLE POSITIVO, na MESMA rodada: a extração funcionou e o documento é
    // reconhecível pelo controlador. Sem isto, "não contém" não distinguiria
    // documento limpo de extração morta.
    expect(texto).toContain(PEDIDO);
    expect(texto).toContain("Loja Exemplo LTDA");
    expect(texto).toContain("ANONIMIZADOS");

    // O que a cascata apagou — do contato E do payload — não pode estar na cópia.
    expect(texto, "a cópia guardou o nome do titular").not.toContain(PII.nome);
    expect(texto).not.toContain(PII.email);
    expect(texto).not.toContain(PII.telefone);
    expect(texto).not.toContain(PII.cpf);
    expect(texto).not.toContain("exemplo.com");
    expect(texto).not.toContain("7777");
    expect(texto).not.toContain("529");
    // Nem as formas MASCARADAS, que é o que o documento imprimia antes.
    expect(texto, "a cópia voltou a imprimir o CPF mascarado").not.toMatch(/\*{3}\.\*{3}\.\*{3}-\d{2}/);
    expect(texto, "a cópia voltou a imprimir o telefone mascarado").not.toMatch(/\*{4}-\d{4}/);
    expect(texto, "a cópia voltou a imprimir o e-mail mascarado").not.toMatch(/\*{3}@/);
    // E não cita lei nenhuma (item 2), também no arquivo gravado.
    expect(texto).not.toMatch(/LGPD|RGPD|GDPR|art\.|artigo|Lei n/i);
  });
});

describe("o encarregado do papel tem o mesmo piso do relatório do art. 18, II (item 6 do CR)", () => {
  it("sem encarregado no cadastro da organização, o papel traz o da instalação", async () => {
    h.estado.dpoDaOrganizacao = "   ";
    h.estado.dpoDaInstalacao = " encarregado@instalacao.test ";

    await processLgpdRedact(evento());

    expect(h.estado.uploads).toHaveLength(1);
    const texto = await extractPdfText(h.estado.uploads[0]!.corpo);
    expect(texto).toContain("Loja Exemplo LTDA");
    expect(texto, "o papel ignorou o encarregado da instalação").toContain("encarregado@instalacao.test");
  });

  it("com encarregado no cadastro, o da organização vence o da instalação", async () => {
    h.estado.dpoDaInstalacao = "encarregado@instalacao.test";

    await processLgpdRedact(evento());

    const texto = await extractPdfText(h.estado.uploads[0]!.corpo);
    expect(texto).toContain("dpo@loja.exemplo");
    expect(texto).not.toContain("encarregado@instalacao.test");
  });
});

describe("a evidência do ato é capturada onde ela existe: na requisição", () => {
  it("a rota de aprovação grava o IP, o autor e o instante no pedido", () => {
    expect(rotaAprovar).toContain("ip: ipDoCliente(req.headers),");
    // O `user_agent` saiu: nada o imprime nem o consome (item 7 do CR).
    expect(rotaAprovar).not.toContain("user_agent");
    // E a evidência só é gravada onde vira papel — o comportamento nos dois
    // sentidos está em `atestado-evidencia-so-onde-ha-papel.test.ts`.
    expect(rotaAprovar).toContain("exclusaoForaDoBrasil(request.request_type, perfil.codigo)");
    expect(rotaAprovar).toContain("user_id: authUser.id,");
    expect(rotaAprovar).toContain("execucao: evidenciaDaExecucao,");
    // O IP é dado de pessoa identificável: entra no pedido, e NÃO na trilha.
    expect(rotaAprovar).not.toContain("ip: ipDoCliente(req.headers)\n    },\n    metadata");
  });

  it("a rota do atestado exige admin e assina URL curta", () => {
    expect(rotaAtestado).toContain('requireRole("admin"');
    expect(rotaAtestado).toContain("createSignedUrl(atestado.path, EXPIRA_EM_SEGUNDOS)");
    expect(rotaAtestado).toContain("EXPIRA_EM_SEGUNDOS = 900");
  });
});
