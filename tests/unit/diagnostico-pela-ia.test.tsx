/**
 * O AGENTE GRAVA O DIAGNÓSTICO NA FICHA — `crm_save_lead_diagnosis` (decisão D7).
 *
 * A cadeia inteira que o turno usa: a ferramenta montada como o turno monta
 * (`pickToolsFromMcp`), com o handler REAL, sobre um banco falso que aplica os
 * filtros e simula a função do banco (`fn_contato_anotar_campos`: tira
 * `p_remover`, mescla `p_campos`, recusa anonimizada e outra organização). O
 * que a função faz de verdade no Postgres — a espera entre transações — é o
 * invariante `tests/invariants/contato-anotar-campos.test.ts`.
 *
 * ─── SABOTAGEM (prevista no corpo do PR) ───────────────────────────────────
 * - Tirar `crm_save_lead_diagnosis` de `ESCOPO_DAS_ESCRITAS`: a ponte passa a
 *   recusar com `escrita_sem_escopo_do_turno` (fecha na dúvida) e os casos da
 *   cerca e da gravação pela ponte caem.
 * - Trocar a mescla por `custom_fields` inteiro no `p_campos`: o caso "outros
 *   campos preservados" cai (o pedaço enviado passa a levar `link_*`).
 * - Tirar a recusa de pessoal: o caso da ficha pessoal cai.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { getToolByName } = await import("@/lib/mcp/tools");
const { catalogEntry } = await import("@/lib/mcp/tools/catalog");
const { MODULOS_OPCIONAIS } = await import("@/lib/instalacao/modulos");
const { CAPACIDADES_DA_ORGANIZACAO } = await import("@/lib/organizacao/capacidades");
const { auditMcpToolCall } = await import("@/lib/mcp/audit");
const { audit } = await import("@/lib/audit");
const { DiagnosticoDoContato } = await import("@/components/contacts/DiagnosticoDoContato");
const { CAPACIDADE_DO_DIAGNOSTICO } = await import("@/lib/prospecting/agent-setup");

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DO_TURNO = "22222222-2222-4222-8222-222222222222";
const DE_B = "66666666-6666-4666-8666-666666666666";
const DE_OUTRA_ORG = "77777777-7777-4777-8777-777777777777";
const PESSOAL = "88888888-8888-4888-8888-888888888888";
const ANONIMIZADO = "99999999-9999-4999-8999-999999999999";
const AGENTE = "33333333-3333-4333-8333-333333333333";
const USUARIO = "44444444-4444-4444-8444-444444444444";
const AGENTE_ANTERIOR = "55555555-5555-4555-8555-555555555555";
const DA_EQUIPE = "12121212-1212-4212-8212-121212121212";
const SEM_DIAGNOSTICO = "13131313-1313-4313-8313-131313131313";
/** CNPJ numérico de exemplo com DV válido. */
const CNPJ = "11222333000181";

const NOME = "crm_save_lead_diagnosis";

type Linha = Record<string, unknown>;

/** A ficha do turno começa com campos que a ferramenta NUNCA pode apagar. */
function fichaDoTurno(): Record<string, unknown> {
  return {
    link_instagram: "instagram.com/padaria",
    link_bio: "paginadelinks.exemplo.com/padaria",
    convenio: "Unimed",
    numero_de_filiais: 3,
    diag_observacoes: "Falar com a Bia, a dona.",
    diag_resumo: "Texto de uma rodada anterior da IA.",
    diag_por: `agente:${AGENTE_ANTERIOR}`,
    diag_em: "2026-11-01T10:00:00.000Z",
  };
}

/** Diagnóstico escrito e ASSINADO por uma pessoa da equipe. */
function fichaDaEquipe(): Record<string, unknown> {
  return {
    link_instagram: "instagram.com/padaria",
    segmento: "Panificação artesanal",
    diag_resumo: "Texto da equipe.",
    diag_por: `usuario:${USUARIO}`,
    diag_em: "2026-11-01T00:00:00.000Z",
  };
}

interface Banco {
  contacts: Linha[];
  crm_pipelines: Linha[];
  rpc: Array<{ nome: string; args: Linha }>;
  /** Anonimiza a ficha ENTRE a leitura do handler e a gravação. */
  anonimizarAntesDaGravacao?: string;
  /** A leitura desta tabela devolve erro (falha de rede, de permissão). */
  falhaNaLeitura?: string;
}

function novoBanco(): Banco {
  return {
    contacts: [
      { id: DO_TURNO, organization_id: ORG, is_anonymized: false, is_personal: false, custom_fields: fichaDoTurno() },
      { id: DE_B, organization_id: ORG, is_anonymized: false, is_personal: false, custom_fields: { intacto: "sim" } },
      { id: DE_OUTRA_ORG, organization_id: ORG_B, is_anonymized: false, is_personal: false, custom_fields: { intacto: "sim" } },
      { id: PESSOAL, organization_id: ORG, is_anonymized: false, is_personal: true, custom_fields: {} },
      { id: ANONIMIZADO, organization_id: ORG, is_anonymized: true, is_personal: false, custom_fields: {} },
      { id: DA_EQUIPE, organization_id: ORG, is_anonymized: false, is_personal: false, custom_fields: fichaDaEquipe() },
      {
        id: SEM_DIAGNOSTICO,
        organization_id: ORG,
        is_anonymized: false,
        is_personal: false,
        custom_fields: { link_instagram: "instagram.com/padaria" },
      },
    ],
    crm_pipelines: [],
    rpc: [],
  };
}

/** Dublê que aplica `eq` e recusa tabela que não conhece (prova que a conferência de campos não roda). */
function clienteFalso(banco: Banco) {
  const from = (tabela: string) => {
    if (tabela !== "contacts" && tabela !== "crm_pipelines") {
      throw new Error(`tabela inesperada: ${tabela}`);
    }
    let linhas = [...((banco as unknown as Record<string, Linha[]>)[tabela] ?? [])];
    const alvo: Record<string, unknown> = {
      eq: (coluna: string, valor: unknown) => {
        linhas = linhas.filter((l) => l[coluna] === valor);
        return cadeia;
      },
      maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve(
          banco.falhaNaLeitura === tabela
            ? { data: null, error: { message: "falha simulada" } }
            : { data: linhas, error: null },
        ).then(ok, falha),
    };
    const cadeia: unknown = new Proxy(alvo, { get: (t, p: string) => (p in t ? t[p] : () => cadeia) });
    return cadeia;
  };
  const rpc = async (nome: string, args: Linha) => {
    banco.rpc.push({ nome, args });
    if (nome !== "fn_contato_anotar_campos") throw new Error(`rpc inesperada: ${nome}`);
    if (banco.anonimizarAntesDaGravacao) {
      const alvo = banco.contacts.find((c) => c.id === banco.anonimizarAntesDaGravacao)!;
      alvo.is_anonymized = true;
      alvo.custom_fields = {};
    }
    // Espelho da função: `(custom_fields - p_remover) || p_campos`, só na
    // linha da organização e não anonimizada.
    const linha = banco.contacts.find(
      (c) => c.organization_id === args.p_org && c.id === args.p_contato && c.is_anonymized !== true,
    );
    if (!linha) return { data: null, error: null };
    const atual = { ...((linha.custom_fields as Linha) ?? {}) };
    for (const chave of (args.p_remover as string[]) ?? []) delete atual[chave];
    linha.custom_fields = { ...atual, ...(args.p_campos as Linha) };
    return { data: linha.custom_fields, error: null };
  };
  return { from, rpc };
}

async function executar(
  banco: Banco,
  args: Linha,
  opcoes: { contatoDoTurno?: string; ator?: Linha } = {},
): Promise<Linha> {
  const supabase = clienteFalso(banco);
  const ator = opcoes.ator ?? { type: "ai_agent", id: "run-1", role: "ai_operator", agent_id: AGENTE };
  const ferramentas = pickToolsFromMcp({
    toolIds: [NOME],
    auth: { organizationId: ORG, role: "ai_operator", scopes: ["mcp:read", "mcp:write"], actor: ator, apiTokenId: "tok-1" },
    ctx: { organizationId: ORG, role: "ai_operator", actor: ator, apiTokenId: "tok-1", requestId: "req-1", supabase },
    supabase,
    pipelineIds: [],
    modulosLigados: MODULOS_OPCIONAIS,
    capacidadesLigadas: CAPACIDADES_DA_ORGANIZACAO,
    handoffToolEnabled: true,
    proposalAiDraftEnabled: true,
    handoffSignal: { triggered: false },
    ...(opcoes.contatoDoTurno ? { contatoDoTurno: opcoes.contatoDoTurno } : {}),
  } as never);
  expect(ferramentas[NOME], "a ferramenta não foi montada no turno").toBeDefined();
  return (await ferramentas[NOME]!.execute!(args, { toolCallId: "c1", messages: [] } as never)) as Linha;
}

const ficha = (banco: Banco, id: string) => banco.contacts.find((c) => c.id === id)!.custom_fields as Linha;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("a ferramenta existe onde precisa existir", () => {
  it("escrita, risco atencao, exige só agent e mcp:write", () => {
    const def = getToolByName(NOME)!;
    expect(def).toMatchObject({ category: "write", requiresRole: "agent", requiresScope: "mcp:write" });
    expect(catalogEntry(NOME)).toMatchObject({ risco: "atencao" });
  });

  it("o agente da prospecção a liga por nome, e o nome é o do catálogo", () => {
    expect(CAPACIDADE_DO_DIAGNOSTICO).toBe(NOME);
  });

  it("fica FORA da conferência de campos: diagnóstico não é algo que o cliente disse", () => {
    const fonte = readFileSync(join(process.cwd(), "lib", "mcp", "tools", "diagnostico.ts"), "utf8");
    expect(fonte).not.toMatch(/from\s+["'][^"']*conferencia-de-campos["']/);
  });

  it("o modelo não escreve observações da equipe nem a autoria: a entrada não tem esses campos", () => {
    expect(Object.keys(getToolByName(NOME)!.inputSchema).sort()).toEqual(
      ["cnpj", "contact_id", "oferta", "resumo", "segmento"].sort(),
    );
  });
});

describe("cerca do turno: só a ficha do contato desta conversa", () => {
  it("outro contato da MESMA organização é recusado pela ponte, e nada chega ao banco", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DE_B, resumo: "Invasão." }, { contatoDoTurno: DO_TURNO });
    expect(r).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, DE_B)).toEqual({ intacto: "sim" });
  });

  it("a ficha do próprio contato do turno é gravada", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DO_TURNO, resumo: "Sem cardápio online." }, { contatoDoTurno: DO_TURNO });
    expect(r).toMatchObject({ gravado: true, campos: ["resumo"], escrito_pela_ia: true });
    expect(ficha(banco, DO_TURNO).diag_resumo).toBe("Sem cardápio online.");
  });
});

describe("organização: contato de outra organização não é tocado", () => {
  it("sem turno (MCP externo), o uuid de outra organização é 'não encontrado' e o banco não é chamado", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DE_OUTRA_ORG, resumo: "Invasão." });
    expect(r).toMatchObject({ gravado: false, motivo: "contato_nao_encontrado" });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, DE_OUTRA_ORG)).toEqual({ intacto: "sim" });
  });

  it("a função do banco recebe a organização do CONTEXTO, nunca dos argumentos", async () => {
    const banco = novoBanco();
    await executar(banco, { contact_id: DO_TURNO, resumo: "Ok.", p_org: ORG_B, organization_id: ORG_B });
    expect(banco.rpc).toHaveLength(1);
    expect(banco.rpc[0]!.args.p_org).toBe(ORG);
  });
});

describe("ficha pessoal ou anonimizada é recusada", () => {
  it("pessoal: motivo contato_pessoal, nada gravado", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: PESSOAL, resumo: "Algo." });
    expect(r).toMatchObject({ gravado: false, motivo: "contato_pessoal" });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, PESSOAL)).toEqual({});
  });

  it("anonimizada: motivo contato_anonimizado, nada gravado", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: ANONIMIZADO, resumo: "Algo." });
    expect(r).toMatchObject({ gravado: false, motivo: "contato_anonimizado" });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, ANONIMIZADO)).toEqual({});
  });

  it("anonimizada entre a leitura e a gravação: a função não grava e a resposta diz o motivo", async () => {
    const banco = novoBanco();
    banco.anonimizarAntesDaGravacao = DO_TURNO;
    const r = await executar(banco, { contact_id: DO_TURNO, resumo: "Algo." });
    expect(r).toMatchObject({ gravado: false, motivo: "contato_anonimizado" });
    expect(ficha(banco, DO_TURNO)).toEqual({});
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("os outros custom_fields ficam como estavam", () => {
  it("⭐ só as chaves do diagnóstico vão ao banco; links, campos da organização e observações sobrevivem", async () => {
    const banco = novoBanco();
    const r = await executar(banco, {
      contact_id: DO_TURNO,
      segmento: "Padaria",
      cnpj: "11.222.333/0001-81",
      resumo: "  Sem cardápio online e sem link de pedido.  ",
      oferta: "Cardápio digital com pedido pelo WhatsApp.",
    });
    expect(r).toMatchObject({ gravado: true, escrito_pela_ia: true });

    const enviado = banco.rpc[0]!.args;
    expect(Object.keys(enviado.p_campos as Linha).sort()).toEqual(
      ["diag_em", "diag_oferta", "diag_por", "diag_resumo", "documento_cnpj", "segmento"].sort(),
    );

    const depois = ficha(banco, DO_TURNO);
    expect(depois).toMatchObject({
      link_instagram: "instagram.com/padaria",
      link_bio: "paginadelinks.exemplo.com/padaria",
      convenio: "Unimed",
      numero_de_filiais: 3,
      diag_observacoes: "Falar com a Bia, a dona.",
      segmento: "Padaria",
      documento_cnpj: CNPJ,
      diag_resumo: "Sem cardápio online e sem link de pedido.",
      diag_oferta: "Cardápio digital com pedido pelo WhatsApp.",
      diag_por: `agente:${AGENTE}`,
    });
  });

  it("chave fora do diagnóstico mandada pelo modelo não chega ao banco", async () => {
    const banco = novoBanco();
    await executar(banco, {
      contact_id: DO_TURNO,
      resumo: "Ok.",
      observacoes: "IA escrevendo no recado da equipe",
      diag_observacoes: "idem",
      diag_por: `usuario:${USUARIO}`,
      link_instagram: "instagram.com/outro",
    });
    const enviado = banco.rpc[0]!.args.p_campos as Linha;
    expect(enviado).not.toHaveProperty("diag_observacoes");
    expect(enviado).not.toHaveProperty("link_instagram");
    expect(enviado.diag_por).toBe(`agente:${AGENTE}`);
    expect(ficha(banco, DO_TURNO).diag_observacoes).toBe("Falar com a Bia, a dona.");
  });

  it("campo de contato declarado pela organização (segmento) não é sobrescrito", async () => {
    const banco = novoBanco();
    banco.crm_pipelines.push({
      organization_id: ORG,
      settings: { fields: [{ key: "segmento", label: "Segmento", type: "select", escopo: "contato" }] },
    });
    const r = await executar(banco, { contact_id: DO_TURNO, segmento: "Padaria", resumo: "Ok." });
    expect(r).toMatchObject({ gravado: true, campos: ["resumo"], preservados: ["segmento"] });
    expect(banco.rpc[0]!.args.p_campos).not.toHaveProperty("segmento");
  });
});

describe("valor inválido é recusado ANTES de gravar", () => {
  it.each([
    ["CNPJ inválido", { cnpj: "123" }, "cnpj"],
    ["resumo só de espaços", { resumo: "   " }, "resumo"],
    ["oferta vazia", { oferta: "" }, "oferta"],
  ])("%s: valor_invalido, nada gravado", async (_nome, campos, campo) => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DO_TURNO, resumo: "Válido.", ...campos });
    expect(r).toMatchObject({ gravado: false, motivo: "valor_invalido", campo });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, DO_TURNO)).toEqual(fichaDoTurno());
  });

  it("sem campo nenhum: nada_para_gravar", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DO_TURNO });
    expect(r).toMatchObject({ gravado: false, motivo: "nada_para_gravar" });
    expect(banco.rpc).toEqual([]);
  });
});

describe("autoria e auditoria", () => {
  it("o texto do diagnóstico não vai para a auditoria (append-only, fora da LGPD)", async () => {
    const banco = novoBanco();
    await executar(banco, { contact_id: DO_TURNO, resumo: "Dona se chama Maria Souza.", oferta: "Site novo." });
    const chamadas = vi.mocked(auditMcpToolCall).mock.calls.map((c) => JSON.stringify(c[0].args));
    expect(chamadas.length).toBeGreaterThan(0);
    for (const a of chamadas) expect(a).not.toContain("Maria Souza");
    const registro = vi.mocked(audit).mock.calls[0]![0];
    expect(registro).toMatchObject({
      action: "contact.diagnosis_saved",
      organizationId: ORG,
      resourceId: DO_TURNO,
      metadata: { campos: ["resumo", "oferta"], escrito_pela_ia: true },
    });
    expect(JSON.stringify(registro)).not.toContain("Maria Souza");
  });

  it("token de integração sem agente: a assinatura antiga SAI (não fica sobre texto que a pessoa não escreveu)", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DO_TURNO, resumo: "Novo." }, { ator: { type: "api_token", id: "tok-1" } });
    expect(r).toMatchObject({ gravado: true, escrito_pela_ia: false });
    expect(banco.rpc[0]!.args.p_remover).toEqual(["diag_por", "diag_em"]);
    expect(ficha(banco, DO_TURNO)).not.toHaveProperty("diag_por");
  });
});

describe("uma pessoa por token assina como ela mesma", () => {
  it("⭐ ator user: diag_por = usuario:<id>, sem selo da IA, e a auditoria leva o id da pessoa", async () => {
    const banco = novoBanco();
    const r = await executar(
      banco,
      { contact_id: DO_TURNO, resumo: "Revisado pela pessoa." },
      { ator: { type: "user", id: USUARIO } },
    );
    expect(r).toMatchObject({ gravado: true, escrito_pela_ia: false });
    expect(ficha(banco, DO_TURNO)).toMatchObject({
      diag_resumo: "Revisado pela pessoa.",
      diag_por: `usuario:${USUARIO}`,
    });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "contact.diagnosis_saved",
      actorUserId: USUARIO,
      metadata: { actor_type: "user", escrito_pela_ia: false },
    });
  });
});

describe("o que a equipe escreveu a IA não sobrescreve", () => {
  it("⭐ resumo assinado por pessoa: recusa escrito_pela_equipe, nada vai ao banco, a ficha segue igual", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DA_EQUIPE, resumo: "Texto da IA.", oferta: "Oferta da IA." });
    expect(r).toMatchObject({ gravado: false, motivo: "escrito_pela_equipe", preservados: ["resumo", "oferta"] });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, DA_EQUIPE)).toEqual(fichaDaEquipe());
    expect(audit).not.toHaveBeenCalled();
  });

  it("o campo vazio a IA completa; o texto e a assinatura da equipe ficam, e a auditoria diz o que ficou", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DA_EQUIPE, cnpj: "11.222.333/0001-81", resumo: "Texto da IA." });
    expect(r).toMatchObject({
      gravado: true,
      campos: ["cnpj"],
      preservados_pela_equipe: ["resumo"],
      escrito_pela_ia: false,
    });
    expect(ficha(banco, DA_EQUIPE)).toMatchObject({
      documento_cnpj: CNPJ,
      diag_resumo: "Texto da equipe.",
      diag_por: `usuario:${USUARIO}`,
    });
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      metadata: { campos: ["cnpj"], preservados_pela_equipe: ["resumo"] },
    });
  });

  it("a aba continua sem o selo depois da tentativa", async () => {
    const banco = novoBanco();
    await executar(banco, { contact_id: DA_EQUIPE, resumo: "Texto da IA." });
    const contato = { id: DA_EQUIPE, organization_id: ORG, name: "Padaria", custom_fields: ficha(banco, DA_EQUIPE) } as never;
    render(<DiagnosticoDoContato contato={contato} podeEditar usuarioId={USUARIO} />);
    expect(screen.queryByText("Escrito pela IA")).toBeNull();
  });
});

describe("token de integração precisa de contacts:write (a mesma régua do crm_update_contact do #4534)", () => {
  const ctxDoToken = (banco: Banco, scopes: readonly string[]) => ({
    organizationId: ORG,
    role: "agent" as const,
    actor: { type: "api_token", id: "tok-1" },
    apiTokenId: "tok-1",
    tokenScopes: scopes,
    requestId: "req-1",
    supabase: clienteFalso(banco),
  });

  it("⭐ sem contacts:write: 403 nomeado, nada vai ao banco", async () => {
    const banco = novoBanco();
    const def = getToolByName(NOME)!;
    await expect(
      def.handler({ contact_id: DO_TURNO, resumo: "x" } as never, ctxDoToken(banco, ["mcp:read", "mcp:write"]) as never),
    ).rejects.toMatchObject({ name: "McpAuthError", httpStatus: 403 });
    expect(banco.rpc).toEqual([]);
    expect(ficha(banco, DO_TURNO)).toEqual(fichaDoTurno());
  });

  it("com contacts:write: grava", async () => {
    const banco = novoBanco();
    const def = getToolByName(NOME)!;
    const r = await def.handler(
      { contact_id: DO_TURNO, resumo: "x" } as never,
      ctxDoToken(banco, ["mcp:read", "mcp:write", "contacts:write"]) as never,
    );
    expect(r).toMatchObject({ gravado: true });
  });

  it("o agente da casa (sem escopos de token) não paga o escopo", async () => {
    const banco = novoBanco();
    const r = await executar(banco, { contact_id: DO_TURNO, resumo: "x" });
    expect(r).toMatchObject({ gravado: true, escrito_pela_ia: true });
  });
});

describe("leitura dos campos da organização falhou: fecha, não grava", () => {
  it("⭐ crm_pipelines com erro: recusa indisponivel, nada vai ao banco", async () => {
    const banco = novoBanco();
    banco.falhaNaLeitura = "crm_pipelines";
    const r = await executar(banco, { contact_id: DO_TURNO, segmento: "clínica" });
    expect(r).toMatchObject({ gravado: false, motivo: "indisponivel" });
    expect(banco.rpc).toEqual([]);
  });
});

describe("o selo Escrito pela IA aparece na aba Diagnóstico", () => {
  it("⭐ o que a ferramenta gravou pinta o selo na ficha", async () => {
    const banco = novoBanco();
    await executar(banco, { contact_id: SEM_DIAGNOSTICO, resumo: "Sem cardápio online.", oferta: "Cardápio digital." });
    const contato = {
      id: SEM_DIAGNOSTICO,
      organization_id: ORG,
      name: "Padaria Exemplo",
      custom_fields: ficha(banco, SEM_DIAGNOSTICO),
    } as never;
    render(<DiagnosticoDoContato contato={contato} podeEditar usuarioId={USUARIO} />);
    expect(screen.getByText("Escrito pela IA")).toBeTruthy();
  });

  it("controle: a mesma ficha antes da ferramenta não tem selo", () => {
    const contato = {
      id: SEM_DIAGNOSTICO,
      organization_id: ORG,
      name: "Padaria",
      custom_fields: novoBanco().contacts.find((c) => c.id === SEM_DIAGNOSTICO)!.custom_fields,
    } as never;
    render(<DiagnosticoDoContato contato={contato} podeEditar usuarioId={USUARIO} />);
    expect(screen.queryByText("Escrito pela IA")).toBeNull();
  });
});
