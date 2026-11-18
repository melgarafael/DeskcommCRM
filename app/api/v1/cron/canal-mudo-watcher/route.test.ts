/**
 * O aviso do canal mudo abre uma vez e fecha sozinho.
 *
 * Os dois casos que mais importam são os do LAÇO DE RETORNO: o aviso tem de
 * sumir quando deixa de ser verdade (o canal ganhou número, saiu do modo de
 * teste ou foi arquivado). Sem isso, a Central acumula avisos que mentem — o
 * canal já responde e a lista diz que não —, e lista que mente ninguém lê.
 *
 * O último caso guarda a régua da auditoria: rodada que não abriu nem fechou
 * nada não é mutação. Uma varredura diária que audita incondicionalmente põe
 * 365 linhas por ano dizendo que nada aconteceu.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { CHANNEL_PROVIDER_SOCIAL, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CANAL_INSTA = "33333333-3333-4333-8333-333333333333";
const VERSAO = "44444444-4444-4444-8444-444444444444";
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

interface Capturado {
  avisos: Array<Record<string, unknown>>;
  resolucoes: Array<{ patch: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}

/**
 * QUEM ATENDE QUAL CANAL — o dublê das quatro tabelas que respondem isso.
 *
 * Default: ninguém tem agente. É o estado do relato da #4909 (Instagram sem
 * nenhuma linha em `ai_agent_version_channels` nem em `ai_agent_versions.
 * channel_session_id`), e o caso que o aviso antigo tratava errado.
 */
interface Extras {
  agentes?: Array<{ published_version_id: string | null }>;
  versoes?: Array<{ channel_session_id: string | null }>;
  vinculos?: Array<{ channel_session_id: string }>;
  roteadores?: Array<{ channel_session_id: string }>;
  /** Tabela que responde com erro — o caminho de falha da rodada. */
  erroEm?: string;
}

/** Consulta thenable e encadeável, como o builder do Supabase. */
function consulta(linhas: unknown[], erro: string | null = null) {
  const resultado = { data: erro === null ? linhas : null, error: erro === null ? null : { message: erro } };
  const c: Record<string, unknown> = {
    select: () => c,
    is: () => c,
    eq: () => c,
    in: () => c,
    limit: async () => resultado,
    maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resultado).then(resolve, reject),
  };
  return c;
}

function admin(
  canais: Array<Record<string, unknown>>,
  abertos: Array<{ id: string; ref_id: string | null }>,
  cap: Capturado,
  extras: Extras = {},
) {
  const erroDe = (tabela: string) => (extras.erroEm === tabela ? "banco fora do ar" : null);
  return {
    from(tabela: string) {
      if (tabela === "channel_sessions") return consulta(canais, erroDe(tabela));
      if (tabela === "ai_agents") return consulta(extras.agentes ?? [], erroDe(tabela));
      if (tabela === "ai_agent_versions") return consulta(extras.versoes ?? [], erroDe(tabela));
      if (tabela === "ai_agent_version_channels") return consulta(extras.vinculos ?? [], erroDe(tabela));
      if (tabela === "ai_routers") return consulta(extras.roteadores ?? [], erroDe(tabela));
      // organizations (idioma do aviso) e agent_inbox_items.
      return {
        select: () => {
          const c: Record<string, unknown> = {
            eq: () => c,
            limit: async () => ({ data: abertos, error: null }),
            maybeSingle: async () => ({ data: { id: "novo" } }),
          };
          return c;
        },
        insert: (linha: Record<string, unknown>) => {
          cap.avisos.push(linha);
          const c: Record<string, unknown> = {
            select: () => c,
            maybeSingle: async () => ({ data: { id: "novo" } }),
          };
          return c;
        },
        update: (patch: Record<string, unknown>) => {
          const filtros: Array<[string, unknown]> = [];
          const c: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filtros.push([col, val]);
              return c;
            },
            select: () => c,
            maybeSingle: async () => {
              cap.resolucoes.push({ patch, filtros: [...filtros] });
              return { data: { id: "resolvido" } };
            },
          };
          return c;
        },
      };
    },
  };
}

const canalMudo = (over: Record<string, unknown> = {}) => ({
  id: CANAL,
  organization_id: ORG,
  status: "WORKING",
  archived_at: null,
  last_status_change_at: diasAtras(5),
  metadata: { ai_gate: "allowlist", ai_test_phone_numbers: [] },
  display_name: "WhatsApp principal",
  phone_number: null,
  // O transporte vem da FRONTEIRA, não digitado aqui: o invariante 1 da
  // doutrina de restrição de canal proíbe uma feature (teste de rota incluído)
  // de nomear provider — ela pergunta pela CAPACIDADE.
  provider: DEFAULT_CHANNEL_PROVIDER,
  ...over,
});

const vazio = (): Capturado => ({ avisos: [], resolucoes: [] });
const req = () =>
  new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("canal-mudo-watcher", () => {
  it("abre o aviso apontando para o canal, com kind e referência certos", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([canalMudo()], [], cap) as never);

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { avisados: number; resolvidos: number } };

    expect(r.status).toBe(200);
    expect(corpo.data).toMatchObject({ avisados: 1, resolvidos: 0 });
    expect(cap.avisos).toHaveLength(1);
    expect(cap.avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "canal_mudo_sem_numero",
      severity: "warn",
      ref_kind: "channel_session",
      ref_id: CANAL,
    });
    // O corpo diz a SAÍDA, não só o diagnóstico: quem lê precisa saber o que fazer.
    expect(String(cap.avisos[0]!.body)).toMatch(/Conexões/);
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo()], [{ id: "aviso-1", ref_id: CANAL }], cap) as never,
    );

    await GET(req());

    expect(cap.avisos).toHaveLength(0);
    expect(cap.resolucoes).toHaveLength(0);
  });

  it("canal que ganhou número tem o aviso RESOLVIDO, com o motivo no corpo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [canalMudo({ metadata: { ai_gate: "allowlist", ai_test_phone_numbers: ["+5511999990000"] } })],
        [{ id: "aviso-1", ref_id: CANAL }],
        cap,
      ) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { resolvidos: number } };

    expect(corpo.data.resolvidos).toBe(1);
    expect(cap.resolucoes[0]!.patch.status).toBe("resolved");
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/ganhou número autorizado/);
    // O filtro por `status=open` é a trava contra duas rodadas simultâneas.
    expect(cap.resolucoes[0]!.filtros).toContainEqual(["status", "open"]);
  });

  it("canal que saiu do modo de teste também resolve", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo({ metadata: { ai_gate: "open" } })], [{ id: "aviso-1", ref_id: CANAL }], cap) as never,
    );

    await GET(req());

    expect(cap.resolucoes).toHaveLength(1);
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/saiu do modo de teste/);
  });

  it("aviso de canal que sumiu da varredura (arquivado) também fecha", async () => {
    // A varredura só lê conexões não arquivadas. Sem este fechamento, arquivar
    // um canal deixaria o aviso dele aberto para sempre.
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([], [{ id: "aviso-orfao", ref_id: "33333333-3333-4333-8333-333333333333" }], cap) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { resolvidos: number } };

    expect(corpo.data.resolvidos).toBe(1);
    expect(String(cap.resolucoes[0]!.patch.body)).toMatch(/arquivado/);
  });

  it("canal recém-ligado não vira aviso — e a rodada não audita", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo({ last_status_change_at: diasAtras(1) })], [], cap) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { avisados: number; resolvidos: number } };

    expect(corpo.data).toMatchObject({ avisados: 0, resolvidos: 0 });
    expect(cap.avisos).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada com efeito audita uma vez, com os números", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([canalMudo()], [], cap) as never);

    await GET(req());

    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "channel.canal_mudo_watcher_run",
      metadata: { avisados: 1, resolvidos: 0 },
    });
  });

  /**
   * #4909 — DOIS CANAIS, DOIS AVISOS, CADA UM COM O SEU NOME.
   *
   * O relato veio de uma instalação com WhatsApp respondendo e um Instagram em
   * teste. O aviso existia, estava certo, e mesmo assim o operador o leu como
   * erro: nada nele dizia de qual canal se tratava. Este teste prende as duas
   * metades da correção — o nome do canal no texto, e dois textos distintos
   * para os dois motivos de o canal estar mudo.
   */
  it("dois canais em estados diferentes: dois textos, cada um nomeando o seu canal", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [
          canalMudo({
            id: CANAL,
            display_name: "WhatsApp principal",
            provider: DEFAULT_CHANNEL_PROVIDER,
          }),
          canalMudo({
            id: CANAL_INSTA,
            display_name: "Instagram da loja",
            provider: CHANNEL_PROVIDER_SOCIAL,
            metadata: { ai_gate: "allowlist", social_platform: "instagram" },
          }),
        ],
        [],
        cap,
        { agentes: [{ published_version_id: VERSAO }], versoes: [{ channel_session_id: CANAL }] },
      ) as never,
    );

    const r = await GET(req());
    const corpo = (await r.json()) as { data: { avisados: number } };

    expect(corpo.data.avisados).toBe(2);
    expect(cap.avisos).toHaveLength(2);

    const zap = cap.avisos.find((a) => a.ref_id === CANAL)!;
    const insta = cap.avisos.find((a) => a.ref_id === CANAL_INSTA)!;

    // Cada aviso nomeia o SEU canal, com a rede que a pessoa conectou.
    expect(String(zap.title)).toContain("WhatsApp principal");
    expect(String(zap.title)).toContain("(WhatsApp)");
    expect(String(insta.title)).toContain("Instagram da loja");
    expect(String(insta.title)).toContain("(Instagram)");
    // E os dois são textos DIFERENTES — era o mesmo nos dois casos antes.
    expect(zap.title).not.toBe(insta.title);

    // O do WhatsApp tem agente: o que falta é liberar um testador.
    expect(String(zap.title)).toMatch(/testador autorizado/);
    expect(String(zap.body)).toMatch(/autorize os números de teste/);
    // O do Instagram não tem agente nenhum: o que falta é ligar o agente.
    expect(String(insta.title)).toMatch(/nenhum agente atende/);
    expect(String(insta.body)).toMatch(/ligar um agente/);
    expect(String(insta.body)).toMatch(/IA › Agentes/);
  });

  it("canal SEM agente não manda abrir ao público — a saída é ligar/publicar o agente", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [
          canalMudo({
            display_name: "Instagram da loja",
            provider: CHANNEL_PROVIDER_SOCIAL,
          }),
        ],
        [],
        cap,
      ) as never,
    );

    await GET(req());

    const aviso = cap.avisos[0]!;
    // A frase que mandava para o clique errado não pode voltar: abrir ao
    // público um canal sem agente deixa o canal tão mudo quanto estava.
    expect(String(aviso.body)).not.toMatch(/abr(?:a|ir)\b/i);
    expect(String(aviso.body)).not.toMatch(/p[uú]blico/i);
    expect(String(aviso.body)).toMatch(/publique uma versão do agente/);
  });

  it("roteador ativo no canal já conta como agente: o aviso é o de testador", async () => {
    // "Tem agente" não é só versão presa ao número: o roteador é a outra forma
    // de o runtime achar quem responde. Contar só a primeira mandaria a pessoa
    // publicar um agente que ela já publicou.
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo()], [], cap, { roteadores: [{ channel_session_id: CANAL }] }) as never,
    );

    await GET(req());

    expect(String(cap.avisos[0]!.title)).toMatch(/testador autorizado/);
  });

  it("sem saber quem atende o canal, a rodada falha e NÃO grava aviso escolhido no chute", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin([canalMudo()], [], cap, { erroEm: "ai_agents" }) as never,
    );

    const r = await GET(req());

    expect(r.status).toBe(500);
    expect(cap.avisos).toHaveLength(0);
  });

  it("sem o segredo, 403 e não lê nada", async () => {
    const cap = vazio();
    const cliente = vi.fn();
    vi.mocked(createAdminClient).mockImplementation(cliente as never);

    const r = await GET(new NextRequest("http://localhost/x"));

    expect(r.status).toBe(403);
    expect(cliente).not.toHaveBeenCalled();
    expect(cap.avisos).toHaveLength(0);
  });
});
