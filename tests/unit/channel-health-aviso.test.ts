import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

/**
 * A conexão caiu — e alguém precisa SABER.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * A sessão saiu de `WORKING` às 13:19. O webhook chegou, a coluna foi
 * atualizada, e ninguém foi avisado. O dono descobriu horas depois, ao estranhar
 * que nenhum cliente escrevia e ir olhar por conta própria. Não havia bug: havia
 * um estado correto guardado onde ninguém passa.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que o aviso saia; que saia UMA vez por episódio (uma Central que repete é uma
 * Central que ninguém lê); que FECHE quando a conexão volta (aviso que não fecha
 * ensina que a Central mostra coisa velha); e que fechar o de uma conexão não
 * apague o de outra que segue caída — o erro mais fácil de cometer aqui, porque
 * filtrar por organização parece certo até haver dois números ligados.
 */
import {
  DETALHE_CREDENCIAL_RECUSADA,
  STATUS_QUE_AVISAM,
  avisoDaConexao,
  resolverSaudeDaConexaoRemovida,
  sincronizarSaudeDaConexao,
} from "@/lib/channels/health";

const viva = { reachable: true, status: "WORKING", detail: null };

describe("quando avisar", () => {
  it("WORKING não avisa nada — é o estado normal", () => {
    expect(avisoDaConexao(viva, "Vendas")).toBeNull();
  });

  it("STARTING não avisa — senão o sistema grita a cada reinício", () => {
    // É o estado normal de todo boot. Avisar aqui é o caminho mais curto para o
    // operador aprender a ignorar a cor do aviso.
    expect(avisoDaConexao({ reachable: true, status: "STARTING", detail: null }, "V")).toBeNull();
  });

  it("SCAN_QR_CODE pede o QR, e diz QUAL conexão caiu", () => {
    // Com dois números ligados, "WhatsApp desconectado" obriga a adivinhar.
    const a = avisoDaConexao({ reachable: true, status: "SCAN_QR_CODE", detail: null }, "Vendas");
    expect(a?.kind).toBe("qr_rescan");
    expect(a?.severity).toBe("critical");
    expect(a?.title).toContain("Vendas");
    expect(a?.title).toMatch(/QR/);
  });

  it("FAILED e STOPPED são críticos — nada entra nem sai", () => {
    for (const s of ["FAILED", "STOPPED"]) {
      const a = avisoDaConexao({ reachable: true, status: s, detail: null }, "Vendas");
      expect(a?.severity, s).toBe("critical");
      expect(a?.kind, s).toBe("channel_number_alert");
      expect(a?.title, s).toContain("Vendas");
    }
  });

  it("STOPPED entra na lista — parada e quebrada se sentem igual", () => {
    // A constante original do watchdog só previa SCAN_QR_CODE e FAILED. Para
    // quem atende, uma sessão parada é indistinguível de uma quebrada: em ambas
    // ninguém recebe mensagem, que é a única coisa que ele sente.
    expect([...STATUS_QUE_AVISAM]).toContain("STOPPED");
  });

  it("não deu para perguntar NÃO vira 'caiu' — a ação é outra", () => {
    // Afirmar queda por uma oscilação de rede ensinaria a ignorar o aviso; e a
    // ação aqui é olhar o serviço, não escanear um QR.
    const a = avisoDaConexao({ reachable: false, status: null, detail: "ECONNREFUSED" }, "Vendas");
    expect(a?.severity).toBe("warn");
    expect(a?.title).not.toMatch(/QR/);
    expect(a?.body).toBe("ECONNREFUSED");
    expect(a?.episodio).toBe("UNREACHABLE");
  });

  it("credencial RECUSADA é crítica, e diz que o QR não resolve", () => {
    // O irmão do caso acima, e o que ele custou: os dois entram por
    // `reachable: false`, mas pedem ações opostas. Numa VPS real a chave do
    // WAHA foi trocada por uma segunda cópia do repo; tudo parou; e por TRÊS
    // DIAS a Central mostrou só o `warn` de "não foi possível verificar" — a
    // frase de uma oscilação passageira. Quem lê "conexão caída" corre atrás do
    // QR, e o QR não conserta chave errada.
    const a = avisoDaConexao(
      { reachable: false, status: null, detail: DETALHE_CREDENCIAL_RECUSADA },
      "Vendas",
    );
    expect(a?.severity).toBe("critical");
    expect(a?.episodio).toBe("CREDENCIAL_RECUSADA");
    expect(a?.title).toContain("Vendas");
    expect(a?.body).toMatch(/QR não resolve/i);
    // Episódio PRÓPRIO: se dividisse "UNREACHABLE" com o caso acima, a troca de
    // um pelo outro não abriria aviso nenhum — o dedup por episódio veria o
    // mesmo valor e ficaria calado justamente na piora.
    const oscilacao = avisoDaConexao(
      { reachable: false, status: null, detail: "ECONNREFUSED" },
      "Vendas",
    );
    expect(a?.episodio).not.toBe(oscilacao?.episodio);
  });

  it("estado desconhecido não vira aviso — o vocabulário é do transporte", () => {
    expect(avisoDaConexao({ reachable: true, status: "ALGO_NOVO", detail: null }, "V")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, unknown][];
}
const ops: Op[] = [];
let escalado: string | null = null;
/**
 * Avisos ABERTOS que o dublê enxerga para esta sessão — é este `select` que
 * decide se há o que fechar quando a conexão é removida (#1023). Vazio é o canal
 * virgem, que é o caso mais comum de exclusão e o que exige ZERO escrita.
 */
let abertos: string[] = [];

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const filtros: [string, unknown][] = [];
  ops.push({ tabela, op, payload, filtros });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle")
          return async () => ({ data: { escalated_status: escalado }, error: null });
        if (prop === "then")
          return (ok: (v: unknown) => unknown) =>
            ok({ data: abertos.map((id) => ({ id })), error: null });
        return (...args: unknown[]) => {
          if (prop === "eq") filtros.push([String(args[0]), args[1]]);
          return proxy;
        };
      },
    },
  ) as Record<string, unknown>;
  return proxy;
}

const admin = {
  from: (t: string) => ({
    select: () => chain(t, "select"),
    insert: (p: unknown) => chain(t, "insert", p),
    update: (p: unknown) => chain(t, "update", p),
    upsert: (p: unknown) => chain(t, "upsert", p),
  }),
} as never;

const sessao = { id: "sess-1", organization_id: "org-1", status: "FAILED" };
const caiu = { reachable: true, status: "FAILED", detail: null };

beforeEach(() => {
  ops.length = 0;
  escalado = null;
  abertos = [];
});

describe("avisar uma vez, e fechar quando volta", () => {
  it("abre o aviso quando cai", async () => {
    expect(await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).toBe("avisado");
    const ins = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "insert");
    expect(ins?.payload).toMatchObject({ kind: "channel_number_alert", severity: "critical" });
  });

  it("marca o aviso com a SESSÃO — sem isso não dá para fechar o certo depois", async () => {
    await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas");
    const ins = ops.find((o) => o.op === "insert");
    expect(ins?.payload).toMatchObject({ ref_kind: "channel_session", ref_id: "sess-1" });
  });

  it("NÃO repete no mesmo episódio — 12 avisos por hora tornam a Central inútil", async () => {
    escalado = "FAILED";
    expect(await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).toBe("ja_avisado");
    expect(ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("mas avisa de novo se o episódio MUDA — mudou o que fazer", async () => {
    // Caiu por QR e agora está FAILED: a ação deixou de ser "escanear".
    escalado = "SCAN_QR_CODE";
    expect(await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas")).toBe("avisado");
  });

  it("fecha o aviso quando a conexão volta", async () => {
    escalado = "FAILED";
    expect(await sincronizarSaudeDaConexao(admin, sessao, viva, "Vendas")).toBe("resolvido");
    const up = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "update");
    expect(up?.payload).toMatchObject({ status: "resolved" });
  });

  it("fecha SÓ o desta conexão — a outra pode seguir caída", async () => {
    // O erro fácil: filtrar por organização. Com dois números ligados, a volta
    // de um apagaria o alerta do outro, que continua fora do ar.
    escalado = "FAILED";
    await sincronizarSaudeDaConexao(admin, sessao, viva, "Vendas");
    const up = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "update");
    expect(Object.fromEntries(up!.filtros)).toMatchObject({ ref_id: "sess-1", status: "open" });
  });

  it("volta ao normal sem episódio aberto não faz nada", async () => {
    expect(await sincronizarSaudeDaConexao(admin, sessao, viva, "Vendas")).toBe("sem_mudanca");
    expect(ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
  });

  it("grava o episódio por UPSERT — a linha de saúde pode não existir ainda", async () => {
    // Com `update`, uma sessão sem linha de saúde não gravaria nada e o dedup
    // pararia de funcionar em silêncio: avisaria de novo a cada rodada.
    await sincronizarSaudeDaConexao(admin, sessao, caiu, "Vendas");
    const g = ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert");
    expect(g, "não gravou o episódio por upsert").toBeTruthy();
    expect(g?.payload).toMatchObject({ escalated_status: "FAILED" });
  });

  it("e limpa o episódio ao resolver — senão nunca mais avisaria", async () => {
    escalado = "FAILED";
    await sincronizarSaudeDaConexao(admin, sessao, viva, "Vendas");
    const g = ops.find((o) => o.tabela === "channel_session_health" && o.op === "upsert");
    expect(g?.payload).toMatchObject({ escalated_status: null });
  });
});

describe("os elos que somem sem barulho", () => {
  it("o webhook de status AVISA de verdade — não é o texto, é o efeito", async () => {
    // Este é o defeito original, exatamente: `handleSessionStatus` atualizava
    // `channel_sessions.status` e terminava.
    //
    // A primeira versão deste caso lia o FONTE procurando a chamada — e passou
    // verde com o sabote `if (false) await sincronizarSaudeDaConexao(...)`.
    // Regex sobre texto não prova alcançabilidade; só executar prova. Aqui o
    // evento entra pelo roteador real e o que se afirma é o aviso GRAVADO.
    const { dispatchWahaEvent } = await import("@/lib/waha/ingest");
    ops.length = 0;
    escalado = null;

    await dispatchWahaEvent(
      admin,
      { id: "sess-1", organization_id: "org-1", is_warmup_complete: null, warmup_started_at: null },
      { event: "session.status", payload: { status: "FAILED" } },
      "req-1",
    );

    const aviso = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "insert");
    expect(aviso, "a queda chegou pelo webhook e ninguém foi avisado").toBeTruthy();
    expect(aviso?.payload).toMatchObject({ kind: "channel_number_alert", ref_id: "sess-1" });
  });

  it("o vigia PERGUNTA — é o único que enxerga o transporte morto", () => {
    // Só o webhook não basta: quando o transporte morre, ele para de mandar
    // evento, e "nenhum evento" fica idêntico a "tudo bem".
    const cron = readFileSync("app/api/v1/cron/channel-health/route.ts", "utf8");
    // A CHAMADA, não a menção: a primeira versão deste caso aceitava o arquivo
    // que só testava `if (!adapter.checkHealth)` e nunca perguntava nada —
    // sobreviveu ao sabote de trocar a pergunta por um literal.
    expect(cron).toMatch(
      /await adapter\.checkHealth\(\{[\s\S]{0,120}?\bsessionRef\b[\s\S]{0,40}?\}\)/,
    );
    // E COM a organização: desde a issue #236 o seam de canal exige o escopo de
    // tenant, e o vigia é quem tem a linha na mão (`s.organization_id`).
    expect(cron).toMatch(/checkHealth\(\{[\s\S]{0,120}?organizationId: s\.organization_id/);
    expect(cron).toMatch(/await sincronizarSaudeDaConexao\(/);
  });

  it("o vigia está AGENDADO — rota sem cron nunca roda", () => {
    // O crontab mora no entrypoint da imagem do scheduler desde que ele deixou
    // de rodar `apk add` a cada start (docs/doctrine/packaging.md, invariante 1).
    const compose = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
    // Com o fim ancorado: `channel-healthXX` CONTÉM `channel-health`, e a
    // primeira versão deste caso passou verde com a rota apontando para o nada.
    expect(compose, "o cron não foi agendado no scheduler").toMatch(
      /cron\/channel-health\s/,
    );
  });

  it("a tela não monta o select de canais à mão", () => {
    // Duas listas divergem com o tempo, e uma faixa que não aparece para um
    // estado que a Central considera grave ensina que a tela está tranquila
    // quando não está. Quem impede a divergência é a tela PERGUNTAR ao seam.
    //
    // Que ela pergunta, e que entrega o retorno à faixa, quem prova é
    // `tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx`, EXECUTANDO o
    // layout. Aqui ficou só a metade que não tem como ser executada: a AUSÊNCIA
    // de uma segunda consulta. Até 2026-09-14 este caso também afirmava
    // `toMatch(/await listarConexoesCaidas\(/)` sobre o texto-fonte — e uma
    // asserção de texto não vigia comportamento, ela cimenta uma
    // implementação: ficou vermelha quando a chamada entrou num `Promise.all`
    // (PR #762), com o mesmo seam, o mesmo retorno e a mesma faixa; e ficaria
    // verde com a chamada dentro de um `if (false)`.
    //
    // A negativa continua aqui porque é sobre o que NÃO existe no arquivo:
    // nenhuma execução prova ausência, e foi uma consulta montada à mão que
    // deixou três seletores oferecendo canal arquivado (invariante
    // `canais-selecionaveis`).
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(layout, "tela montando o select de canais à mão").not.toMatch(
      /from\(\s*["'`]channel_sessions/,
    );
  });

  it("o vigia não pergunta QUEM é o canal — passa pelo seam", () => {
    // Nomear o provider aqui seria o `if (provider === ...)` que a doutrina
    // proíbe, e que o `lint:channels` reprova.
    const cron = readFileSync("app/api/v1/cron/channel-health/route.ts", "utf8");
    expect(cron).not.toMatch(/"waha"|'waha'|meta_cloud|zernio/);
  });
});

// ---------------------------------------------------------------------------
// A conexão REMOVIDA — o episódio não fica sem emissor (#1023)
// ---------------------------------------------------------------------------

/**
 * O único caminho que fechava um episódio era a própria sessão voltar
 * (`sincronizarSaudeDaConexao` pelo `session.status`). Arquivar/excluir tira
 * esse emissor para sempre: a sessão sai do WAHA, o webhook passa a recusar
 * evento do canal arquivado, e o crítico fica aberto sobre uma linha que a tela
 * já não carrega. A remoção é do usuário — o aviso tem de sair junto.
 */
describe("a conexão removida fecha o próprio episódio (#1023)", () => {
  it("⭐ aviso aberto → resolvido, e o episódio da linha de saúde volta a null", async () => {
    abertos = ["i1"];
    escalado = "PUSH:FAILED";

    expect(await resolverSaudeDaConexaoRemovida(admin, sessao)).toBe("resolvido");

    const item = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "update");
    expect(item?.payload).toMatchObject({ status: "resolved" });
    // Sem zerar o episódio, uma reconexão no mesmo status nunca mais avisaria.
    const saude = ops.find((o) => o.tabela === "channel_session_health" && o.op === "update");
    expect(saude?.payload).toMatchObject({ escalated_status: null });
  });

  it("fecha SÓ o desta conexão — a outra pode seguir caída", async () => {
    abertos = ["i1"];
    await resolverSaudeDaConexaoRemovida(admin, sessao);
    const item = ops.find((o) => o.tabela === "agent_inbox_items" && o.op === "update");
    expect(Object.fromEntries(item!.filtros)).toMatchObject({
      ref_id: "sess-1",
      ref_kind: "channel_session",
      status: "open",
      organization_id: "org-1",
    });
  });

  it("⭐ sem aviso aberto e sem episódio → NENHUMA escrita", async () => {
    abertos = [];
    escalado = null;

    expect(await resolverSaudeDaConexaoRemovida(admin, sessao)).toBe("sem_mudanca");
    expect(ops.some((o) => o.op !== "select")).toBe(false);
  });

  it("NÃO cria linha de saúde — no delete ela já caiu junto com a sessão", async () => {
    // `channel_session_health.channel_session_id` é `on delete cascade`: um
    // upsert aqui morreria com violação de FK e derrubaria uma exclusão que o
    // operador já pediu e que já aconteceu.
    abertos = ["i1"];
    escalado = "FAILED";

    await resolverSaudeDaConexaoRemovida(admin, sessao);
    expect(ops.some((o) => o.tabela === "channel_session_health" && o.op === "upsert")).toBe(false);
    expect(ops.some((o) => o.tabela === "channel_session_health" && o.op === "update")).toBe(true);
  });
});
