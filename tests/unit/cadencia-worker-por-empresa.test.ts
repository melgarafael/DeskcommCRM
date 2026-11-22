/**
 * O WORKER DE CADÊNCIA com a EMPRESA na ponta (#4871, F2) — RODADA INTEIRA.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * O cron `cadencia-worker` não tem "a empresa do request": `processarCadencias`
 * reivindica a fila de `email_cadence_enrollments` inteira e percorre o
 * resultado, então a decisão por empresa só pode ser tomada DENTRO do laço, por
 * inscrição. É o que a rodada daqui exercita — duas empresas na MESMA execução,
 * uma com a cadência desligada e outra com ela ligada, e não uma unidade
 * isolada de `cadenciasLigadas`.
 *
 * ─── Quem decide o quê ──────────────────────────────────────────────────────
 *
 *  - INSTALAÇÃO: `moduloLigado(db, "cadencias")`, antes de reivindicar. Desligada,
 *    a rodada sai sem uma leitura de fila. É TETO: nem a empresa ligada roda.
 *  - EMPRESA: `cadenciasLigadas(db, org)`, por inscrição — a capacidade dela
 *    (`settings.cadencias.enabled`, escrita por `fn_cadencias_configurar`) e a
 *    organização operante. Sem a chave, a empresa não recebe sequência nenhuma.
 *
 * `moduloLigado` é o único dublê: ele é a decisão da instalação (banco de fora),
 * e a camada por empresa dos módulos de TABELA é F3 do #3868 (`organization_modules`
 * não cobre `cadencias`). Todo o resto — inclusive `cadenciasLigadas` — roda de
 * verdade sobre um banco falso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configuracaoPadrao } from "@/lib/cadencias/exemplos";
import type { Passo } from "@/lib/cadencias/tipos";
import { processarCadencias } from "@/lib/cadencias/worker";
import type { createAdminClient } from "@/lib/supabase/admin";

const mocks = vi.hoisted(() => ({ instalacao: vi.fn(), enviar: vi.fn() }));

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.instalacao }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: mocks.enviar }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://cadencias.test", CADENCIA_LIMITE_EMAILS_POR_DIA: 60 },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: vi.fn() }));

const agora = new Date("2026-10-26T15:00:00Z"); // 12h em São Paulo: dentro da janela
const email: Passo = {
  id: "email-1",
  tipo: "email",
  assunto: "Olá {{primeiro_nome}}",
  corpo: "Uma mensagem sintética",
  mesmaConversa: false,
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_LIGADA = id(100);
const ORG_DESLIGADA = id(101);

interface InscricaoFalsa {
  id: string;
  organization_id: string;
  cadence_id: string;
  lead_id: string;
  contact_id: string;
  passo_atual_id: string | null;
  ultimo_email_em: string | null;
  ultimo_email_passo_id: string | null;
  aberturas: number;
  aberturas_ultimo_email: number;
  emails_enviados: number;
  tentativas: number;
  inscrito_por: string | null;
  rastreio_consentido: boolean;
  envio_pendente_passo_id: string | null;
  processamento_id: string | null;
  status: string;
  proximo_em: string;
  ultimo_erro?: string | null;
}

/**
 * Um banco falso com DUAS inscrições, de duas empresas, na mesma fila — é a
 * forma de a rodada provar que pular uma não custa a outra.
 */
function bancada(opcoes: { settingsDaDesligada?: unknown } = {}) {
  const inscricoes: InscricaoFalsa[] = [ORG_LIGADA, ORG_DESLIGADA].map((org, i) => ({
    id: id(i + 1),
    organization_id: org,
    cadence_id: id(3),
    lead_id: id(10 + i),
    contact_id: id(20 + i),
    passo_atual_id: null,
    ultimo_email_em: null,
    ultimo_email_passo_id: null,
    aberturas: 0,
    aberturas_ultimo_email: 0,
    emails_enviados: 0,
    tentativas: 0,
    inscrito_por: null,
    rastreio_consentido: false,
    envio_pendente_passo_id: null,
    processamento_id: null,
    status: "ativa",
    proximo_em: agora.toISOString(),
  }));

  const organizacoes: Record<string, { settings: unknown; status: string }> = {
    [ORG_LIGADA]: { settings: { cadencias: { enabled: true } }, status: "active" },
    [ORG_DESLIGADA]: { settings: "settingsDaDesligada" in opcoes ? opcoes.settingsDaDesligada : { cadencias: { enabled: false } }, status: "active" },
  };

  const eventos: Record<string, unknown>[] = [];
  let reivindicacoes = 0;

  const rpc = async (nome: string, args: Record<string, unknown>) => {
    if (nome === "fn_cadencias_reivindicar") {
      reivindicacoes++;
      const instante = String(args.p_agora);
      return {
        data: inscricoes
          .filter((i) => i.status === "ativa" && i.proximo_em <= instante)
          .map((i) => {
            i.processamento_id = id(90 + inscricoes.indexOf(i));
            return { ...i };
          }),
        error: null,
      };
    }
    if (nome === "fn_cadencia_reservar_destinatario") {
      const inscricao = inscricoes.find((i) => i.id === args.p_enrollment_id)!;
      if (inscricao.processamento_id !== args.p_processamento_id) {
        return { data: null, error: { message: "cadencia_claim_lost" } };
      }
      inscricao.envio_pendente_passo_id = args.p_passo_id as string;
      return {
        data: { destinatario_id: id(80), email: `contato-${inscricao.organization_id}@synthetic.test` },
        error: null,
      };
    }
    throw new Error(`RPC inesperada: ${nome}`);
  };

  function from(tabela: string) {
    const filtros: [string, unknown][] = [];
    let patch: Record<string, unknown> | null = null;
    let insercao: Record<string, unknown> | null = null;

    const executar = () => {
      if (tabela === "email_cadences") {
        return { data: { id: id(3), status: "ativa", passos: [email], configuracao: configuracaoPadrao() }, error: null };
      }
      if (tabela === "organizations") {
        const org = String(filtros.find(([campo]) => campo === "id")?.[1] ?? "");
        return { data: organizacoes[org] ?? null, error: null };
      }
      if (tabela === "contacts") {
        const contato = String(filtros.find(([campo]) => campo === "id")?.[1] ?? "");
        return {
          data: {
            email: `contato-${contato}@synthetic.test`,
            name: "Pessoa Sintética",
            display_name: "Pessoa Sintética",
            is_anonymized: false,
            is_blocked: false,
            is_personal: false,
            consent: null,
          },
          error: null,
        };
      }
      if (tabela === "crm_leads") return { data: { owner_user_id: null, status: "open" }, error: null };
      if (tabela === "email_cadence_events") {
        if (insercao) eventos.push(insercao);
        return { data: null, error: null };
      }
      if (tabela === "email_cadence_enrollments") {
        if (!patch) return { data: [...inscricoes], error: null };
        const alvo = inscricoes.find((i) => filtros.every(([campo, valor]) => (i as unknown as Record<string, unknown>)[campo] === valor));
        if (!alvo) return { data: null, error: null };
        Object.assign(alvo, patch);
        return { data: { id: alvo.id }, error: null };
      }
      throw new Error(`Tabela inesperada: ${tabela}`);
    };

    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      lte: () => q,
      or: () => q,
      in: () => q,
      order: () => q,
      is: (campo: string, valor: unknown) => {
        filtros.push([campo, valor]);
        return q;
      },
      eq: (campo: string, valor: unknown) => {
        filtros.push([campo, valor]);
        return q;
      },
      update: (valor: Record<string, unknown>) => {
        patch = valor;
        return q;
      },
      insert: (valor: Record<string, unknown>) => {
        insercao = valor;
        return q;
      },
      maybeSingle: async () => executar(),
      single: async () => executar(),
      then: (resolve: (valor: unknown) => unknown) => Promise.resolve(executar()).then(resolve),
    };
    return q;
  }

  return {
    admin: { from, rpc } as unknown as ReturnType<typeof createAdminClient>,
    inscricao: (org: string) => inscricoes.find((i) => i.organization_id === org)!,
    reivindicacoes: () => reivindicacoes,
    eventos,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // O link de descadastro/pixel é assinado com o segredo da instalação.
  vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-para-provar-a-rodada");
  mocks.instalacao.mockResolvedValue(true);
  mocks.enviar.mockResolvedValue({ ok: true, via: "smtp" });
});

afterEach(() => vi.unstubAllEnvs());

describe("cadencia-worker — o piso do módulo por empresa (#4871)", () => {
  it("instalação desligada: nada roda — nem a empresa que tem a cadência ligada", async () => {
    mocks.instalacao.mockResolvedValue(false);
    const b = bancada();

    const resultado = await processarCadencias(b.admin, agora, "request-sintetico");

    expect(resultado).toEqual({ processadas: 0, emailsEnviados: 0, concluidas: 0, paradas: 0, falhas: 0 });
    expect(b.reivindicacoes()).toBe(0);
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it("instalação ligada + empresa desligada: a desligada NÃO recebe, e a ligada é processada na MESMA execução", async () => {
    const b = bancada();

    const resultado = await processarCadencias(b.admin, agora, "request-sintetico");

    // A empresa que desligou: nenhum e-mail sai, o passo dela não anda.
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    const envio = mocks.enviar.mock.calls[0]![0] as { to: string };
    expect(envio.to).toBe(`contato-${ORG_LIGADA}@synthetic.test`);
    const desligada = b.inscricao(ORG_DESLIGADA);
    expect(desligada.passo_atual_id).toBeNull();
    expect(desligada.emails_enviados).toBe(0);
    expect(desligada.status).toBe("ativa");
    // Adiada, não perdida: sai da rodada e volta na próxima, sem avançar o passo.
    expect(new Date(desligada.proximo_em).getTime()).toBeGreaterThan(agora.getTime());
    expect(desligada.envio_pendente_passo_id).toBeNull();
    // A ligada, na MESMA rodada: e-mail enviado e inscrição concluída (passo único).
    expect(b.inscricao(ORG_LIGADA).emails_enviados).toBe(1);
    expect(b.inscricao(ORG_LIGADA).status).toBe("concluida");
    expect(resultado.emailsEnviados).toBe(1);
  });

  it("sem chave da empresa (linha ausente): herda a instalação e é processada", async () => {
    // A empresa sem exceção em `organization_modules` é o caso normal: nada
    // gravado, e a instalação manda. As DUAS rodam na mesma batida.
    const b = bancada({ settingsDaDesligada: { cadencias: { enabled: true } } });

    const resultado = await processarCadencias(b.admin, agora, "request-sintetico");

    expect(mocks.enviar).toHaveBeenCalledTimes(2);
    expect(resultado.emailsEnviados).toBe(2);
    expect(b.inscricao(ORG_DESLIGADA).emails_enviados).toBe(1);
  });

  it("cadência da empresa AUSENTE nas configurações: não recebe (chave explícita, falha fechada)", async () => {
    const b = bancada({ settingsDaDesligada: {} });

    await processarCadencias(b.admin, agora, "request-sintetico");

    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(b.inscricao(ORG_DESLIGADA).emails_enviados).toBe(0);
  });

  it("leitura do módulo que falha: NINGUÉM é processado (não assume ligado)", async () => {
    // `moduloLigado` sem empresa = a instalação (ligada); com empresa = a leitura
    // que falhou, que responde `false` — a mesma falha fechada de `modulosLigados`.
    mocks.instalacao.mockImplementation(async (_db: unknown, _modulo: string, organizacaoId?: string | null) => organizacaoId === undefined);
    const b = bancada({ settingsDaDesligada: { cadencias: { enabled: true } } });

    const resultado = await processarCadencias(b.admin, agora, "request-sintetico");

    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(resultado.emailsEnviados).toBe(0);
    expect(b.inscricao(ORG_LIGADA).emails_enviados).toBe(0);
    expect(b.inscricao(ORG_DESLIGADA).emails_enviados).toBe(0);
  });

  it("controle positivo: as duas empresas ligadas recebem na MESMA rodada", async () => {
    const b = bancada({ settingsDaDesligada: { cadencias: { enabled: true } } });

    const resultado = await processarCadencias(b.admin, agora, "request-sintetico");

    expect(mocks.enviar).toHaveBeenCalledTimes(2);
    expect(resultado.emailsEnviados).toBe(2);
    expect(b.eventos.filter((e) => e.tipo === "email_enviado")).toHaveLength(2);
  });
});
