import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { assertAgentOperationPg } from "@/lib/ai/agents/operation";
import { assertCurrentServiceBoundary, parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import type { ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { WahaClient } from "@/lib/waha/client";
import { ehVistoAzul } from "../support/waha-visto-azul";

/**
 * Executa os nós REAIS do host com falhas dirigidas nas bordas. Não importa o
 * runtime inteiro, não copia sua implementação e não inicia banco ou canal.
 */
function noReal(caminho: string, aceita: (no: ts.Node, fonte: ts.SourceFile) => boolean) {
  const fonte = ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true);
  let encontrado: ts.Node | undefined;
  const visitar = (no: ts.Node) => {
    if (aceita(no, fonte)) encontrado = no;
    if (!encontrado) ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  if (!encontrado) throw new Error(`Nó real ausente em ${caminho}`);
  return encontrado.getText(fonte).replace(/^export /, "");
}

function compilar(codigo: string) {
  return ts.transpileModule(codigo, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const passagemReal = noReal("lib/agent-engine/agent/human-handoff.ts",
  (no) => ts.isFunctionDeclaration(no) && no.name?.text === "gravarPassagemComRecibo");
const envioReal = noReal("lib/agent-engine/agent/gancho-de-extensao.ts",
  (no) => ts.isFunctionDeclaration(no) && no.name?.text === "enviarTextoSemModelo");
const callbackReal = noReal("lib/agent-engine/agent/inbound-turn.ts",
  (no, fonte) => ts.isPropertyAssignment(no) && no.name.getText(fonte) === "passarParaHumano" && ts.isArrowFunction(no.initializer));
const coletaReal = noReal("lib/agent-engine/agent/inbound-turn.ts",
  (no, fonte) => ts.isPropertyAssignment(no) && no.name.getText(fonte) === "enviar" &&
    ts.isArrowFunction(no.initializer) && no.initializer.getText(fonte).includes("enviarTextoSemModelo"));
const sinkReal = noReal("lib/agent-engine/edge/crm/send-message.ts",
  (no) => ts.isFunctionDeclaration(no) && no.name?.text === "sendTurnMessage");
const fronteiraReal = ["readCurrentServiceBoundary", "requireCurrentServiceBoundary", "requireCurrentAutonomousTurn"]
  .map(nome => noReal("lib/atendimento/fronteira-server.ts", no => ts.isFunctionDeclaration(no) && no.name?.text === nome)).join("\n");
const sqlDaFronteira = noReal("lib/atendimento/fronteira-server.ts",
  no => ts.isVariableStatement(no) && no.declarationList.declarations.some(d => d.name.getText() === "SERVICE_BOUNDARY_SQL"));
const claim = { worker_id: "worker-sintetico", acquired_at: "2026-10-27 13:00:00.123456+00" };
const operacao = { organizationId: "org-sintetica", agentId: "agente-sintetico", versionId: "versao-sintetica", revision: "7" };
const receptorReal = noReal("tests/e2e/fixtures/turno-laudos.ts",
  no => ts.isVariableDeclaration(no) && no.name.getText() === "servidor");
const presencaReal = noReal("lib/channels/adapters/waha.ts",
  no => ts.isMethodDeclaration(no) && no.name.getText() === "signalTyping");

async function gravar(opts: { falha?: RegExp; rollbackFalha?: boolean; repetido?: boolean; registroFalha?: boolean } = {}) {
  const erroConsulta = new Error("Query read timeout");
  const erroRollback = new Error("rollback incerto");
  const query = vi.fn(async (sql: string) => {
    if (sql === "rollback" && opts.rollbackFalha) throw erroRollback;
    if (opts.falha?.test(sql)) throw erroConsulta;
    return { rows: [{ msg: opts.repetido ? "tentativa-1" : null }] };
  });
  const release = vi.fn();
  const registrarPassagem = vi.fn(async () => opts.registroFalha
    ? { gravada: false, erro: "insert não confirmado" }
    : { gravada: true });
  const log = { info: vi.fn(), warn: vi.fn() };
  const executar = runInNewContext(`${compilar(passagemReal)}; gravarPassagemComRecibo`, {
    Error, registrarPassagem, CHAVE_DO_RECIBO_DA_PASSAGEM: "passagem_verificacao_manual",
  }) as (db: unknown, ids: unknown, nova: unknown, chave: string, logger: unknown) => Promise<void>;
  // O best effort continua resolvendo; não transformar falha da informação em retry geral.
  await expect(executar({ connect: async () => ({ query, release }) },
    { tenantId: "org-sintetica", conversationId: "conversa-sintetica" }, {}, "tentativa-1", log)).resolves.toBeUndefined();
  expect(release).toHaveBeenCalledTimes(1);
  return { query, release, registrarPassagem, log, erroConsulta, erroRollback };
}

describe("a transação real da passagem não devolve cliente incerto ao pool", () => {
  it("commit saudável reutiliza o cliente", async () => {
    const r = await gravar();
    expect(r.query).toHaveBeenCalledWith("commit");
    expect(r.release.mock.calls[0]?.[0]).toBeUndefined();
    expect(r.registrarPassagem).toHaveBeenCalledTimes(1);
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it("recibo repetido com rollback saudável não duplica e reutiliza", async () => {
    const r = await gravar({ repetido: true });
    expect(r.query).toHaveBeenCalledWith("rollback");
    expect(r.registrarPassagem).not.toHaveBeenCalled();
    expect(r.release.mock.calls[0]?.[0]).toBeUndefined();
    expect(r.log.warn).not.toHaveBeenCalled();
  });

  it.each([/^begin$/, /advisory/, /^update conversations/, /^commit$/])(
    "erro de query %s descarta mesmo quando rollback responde", async (falha) => {
      const r = await gravar({ falha });
      expect(r.query).toHaveBeenCalledWith("rollback");
      expect(r.release.mock.calls[0]?.[0]).toBe(r.erroConsulta);
      expect(r.log.warn).toHaveBeenCalledTimes(1);
    },
  );

  it("timeout de query e rollback incerto descartam uma única vez", async () => {
    const r = await gravar({ falha: /advisory/, rollbackFalha: true });
    expect(r.release.mock.calls[0]?.[0]).toBe(r.erroConsulta);
    expect(r.log.warn).toHaveBeenCalledTimes(1);
  });

  it("rollback do recibo repetido que falha também descarta", async () => {
    const r = await gravar({ repetido: true, rollbackFalha: true });
    expect(r.release.mock.calls[0]?.[0]).toBe(r.erroRollback);
    expect(r.registrarPassagem).not.toHaveBeenCalled();
  });

  it("registro que absorveu falha de INSERT não libera conexão como saudável", async () => {
    const r = await gravar({ registroFalha: true });
    expect(r.query).toHaveBeenCalledWith("rollback");
    expect(r.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(r.log.warn).toHaveBeenCalledTimes(1);
  });
});

async function passar(kind: string) {
  let aviso: unknown;
  const canal = { send: vi.fn(async () => ({ kind, idempotencyKey: "chave", messageId: "mensagem" })) };
  const callbacks = runInNewContext(compilar(`${envioReal}\nconst callbacks = {${coletaReal},${callbackReal}};`) +
    "; callbacks", {
    runBeforeSend: async (args: { body: string; send(body: string): Promise<unknown> }) => kind === "vetoed"
      ? { status: "vetoed", code: "messaging_window_closed" }
      : { status: "sent", outcome: await args.send(args.body), trace: [] },
    erroCurto: () => "erro_sintetico", pool: {}, runLog: { warn() {}, info() {} },
    tenantId: "org-sintetica", leadId: "contato-sintetico",
    input: { conversationId: "conversa-sintetica", channelSessionId: "canal-sintetico" },
    liveJob: () => ({ id: "job-sintetico", locked_by: claim.worker_id, claim_acquired_at: claim.acquired_at }),
    claimOfJob, agentOperation: operacao, agentConfig: null, liveChannel: () => canal,
    optedOutThisTurn: false, clock: () => new Date("2026-10-26T12:00:00Z"),
    performHumanHandoff: async (_db: unknown, _ids: unknown, opts: { avisoAoLead: unknown }) => { aviso = opts.avisoAoLead; },
  }) as { enviar(texto: string): Promise<boolean>; passarParaHumano(args: unknown): Promise<void> };
  // A fila conserva a custódia da coleta: não devolver à IA nem repetir envio.
  expect(await callbacks.enviar("Pergunta sintética.")).toBe(["sent", "already_sent", "queued"].includes(kind));
  expect(canal.send).toHaveBeenCalledTimes(kind === "vetoed" ? 0 : 1);
  if (kind !== "vetoed") expect(canal.send).toHaveBeenLastCalledWith(expect.objectContaining({ jobClaim: claim, agentOperation: operacao }));
  canal.send.mockClear();
  await callbacks.passarParaHumano({ campos: { categoria: "patologia" }, aviso: "Passando para a equipe.", idempotencia: "tentativa-1" });
  expect(canal.send).toHaveBeenCalledTimes(kind === "vetoed" ? 0 : 1);
  if (kind !== "vetoed") expect(canal.send).toHaveBeenLastCalledWith(expect.objectContaining({ jobClaim: claim, agentOperation: operacao }));
  return aviso;
}

describe("o helper e o callback reais preservam o fato do aviso", () => {
  it.each(["sent", "already_sent"])("%s chega à passagem como aviso entregue", async (kind) => {
    expect(await passar(kind)).toEqual({ avisado: true });
  });

  it("queued mantém custódia e chega à passagem como ainda não avisado", async () => {
    expect(await passar("queued")).toEqual({
      avisado: false, porque: "na_fila_canal_fora", motivoCodigo: "na_fila_canal_fora",
    });
  });

  it.each(["blocked", "failed", "unavailable", "vetoed"])("%s não afirma entrega nem repete envio", async (kind) => {
    expect(await passar(kind)).toMatchObject({ avisado: false });
  });
});

async function envioAteOLedger(opts: { semClaim?: boolean; claimRevogado?: boolean; agentePausado?: boolean; fronteiraTrocada?: boolean } = {}) {
  const fronteira = { organization_id: "org-sintetica", contact_id: "contato-sintetico", conversation_id: "conversa-sintetica", service_revision: 1, demanda_id: null, demanda_revision: null };
  // Só as quatro leituras anteriores ao ledger; SQL não previsto falha. Isto
  // mede os nós reais com bordas dirigidas, não executa SQL nem prova banco.
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("select published_version_id")) {
      expect(params).toEqual(["org-sintetica", "agente-sintetico"]);
      return { rows: [{ published_version_id: "versao-sintetica", operation_revision: "7", operation_mode: "automatic", paused_at: opts.agentePausado ? "2026-10-27T13:00:00Z" : null, archived_at: null }] };
    }
    if (sql.startsWith("select payload,kind")) {
      expect(params).toEqual(["job-sintetico", "org-sintetica", "contato-sintetico"]);
      return { rows: [{ kind: "inbound_turn", payload: { service_boundary: fronteira } }] };
    }
    if (sql.startsWith("select c.organization_id")) {
      expect(params).toEqual(["org-sintetica", "conversa-sintetica"]);
      return { rows: [{ ...fronteira, service_revision: opts.fronteiraTrocada ? 2 : 1, status: "open", demanda_fechada_em: null }] };
    }
    if (sql.startsWith("select exists")) {
      expect(params).toEqual(["org-sintetica", "job-sintetico", "contato-sintetico", "inbound_turn", "worker-sintetico", "2026-10-27 13:00:00.123456+00"]);
      return { rows: [{ current: !opts.claimRevogado }] };
    }
    throw new Error("Leitura não prevista na prova anterior ao ledger.");
  });
  const ledger = vi.fn(async (_ledger: unknown, _input: ChannelSendInput) => ({ kind: "sent", idempotencyKey: "chave", messageId: "mensagem" }));
  const executar = runInNewContext(compilar(envioReal) + "; enviarTextoSemModelo", {
    runBeforeSend: async (args: { body: string; send(body: string): Promise<unknown> }) => ({ status: "sent", outcome: await args.send(args.body) }),
  }) as (args: unknown) => Promise<unknown>;
  const enviarNoSink = runInNewContext(compilar(`${sqlDaFronteira}\n${fronteiraReal}\n${sinkReal}`) + "; sendTurnMessage", {
    assertAgentOperationPg, assertCurrentServiceBoundary, parseServiceBoundary, claimOfJob, StaleServiceBoundaryError,
    pgSendLedger: () => ({}), sendWithLedger: ledger,
  }) as (db: unknown, cfg: unknown, input: ChannelSendInput) => Promise<unknown>;
  const resultado = executar({
    pool: { query }, log: { warn() {}, info() {} }, tenantId: "org-sintetica", leadId: "contato-sintetico",
    conversationId: "conversa-sintetica", channelSessionId: "canal-sintetico", jobId: "job-sintetico",
    jobClaim: opts.semClaim ? undefined : claim, agentOperation: operacao, agentId: "agente-sintetico",
    channel: { send: (input: ChannelSendInput) => enviarNoSink({ query }, {}, input) },
    texto: "Pergunta sintética.", optedOutThisTurn: false, agora: new Date("2026-10-27T13:00:00Z"), seq: 1,
  });
  if (Object.values(opts).some(Boolean)) await expect(resultado).rejects.toBeInstanceOf(StaleServiceBoundaryError);
  else await expect(resultado).resolves.toMatchObject({ aceito: true });
  return { query, ledger };
}

describe("o envio real da extensão conserva as cercas antes do ledger", () => {
  it("claim com microssegundos e operação atual permitem chegar ao ledger", async () => {
    const r = await envioAteOLedger();
    expect(r.ledger).toHaveBeenCalledTimes(1);
    expect(r.ledger.mock.calls[0]?.[1]).toMatchObject({ jobClaim: claim, agentOperation: operacao });
  });

  it.each([{ semClaim: true }, { claimRevogado: true }, { agentePausado: true }, { fronteiraTrocada: true }])(
    "%j recusa antes de criar intenção de envio", async opts => {
      const r = await envioAteOLedger(opts);
      expect(r.ledger).not.toHaveBeenCalled();
    },
  );
});

async function comReceiverReal(acao: (client: WahaClient, origem: string) => Promise<void>) {
  const entregas: unknown[] = [];
  const falhasHttp: string[] = [];
  const servidor = runInNewContext(compilar(`const ${receptorReal};`) + "; servidor", {
    createServer, ehVistoAzul, randomUUID, entregas, falhasHttp,
  }) as Server;
  try {
    await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
    const origem = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    await acao(new WahaClient(origem, "chave-sintetica-so-loopback"), origem);
    return { entregas, falhasHttp };
  } finally {
    servidor.closeAllConnections();
    await new Promise<void>((resolve, reject) => servidor.close(erro => erro ? reject(erro) : resolve()));
  }
}

describe("o receiver real da jornada reconhece a presença do adapter real", () => {
  it("digitando não é entrega e o texto seguinte continua sendo uma entrega", async () => {
    const r = await comReceiverReal(async client => {
      const adapter = runInNewContext(compilar(`const adapter = {${presencaReal}};`) + "; adapter", {
        getWahaClient: () => client,
      }) as { signalTyping(input: { sessionRef: string; recipient: string }): Promise<void> };
      await adapter.signalTyping({ sessionRef: "laudo-sintetico", recipient: "15550000001@c.us" });
      await client.sendMessage("laudo-sintetico", "15550000001@c.us", "Pergunta sintética.");
    });
    expect(r.falhasHttp).toEqual([]);
    expect(r.entregas).toEqual([{ session: "laudo-sintetico", text: "Pergunta sintética." }]);
  });

  it.each([
    { method: "GET", path: "/api/laudo-sintetico/presence", body: undefined },
    { method: "POST", path: "/api/laudo-sintetico/presence", body: { chatId: "15550000001@c.us", presence: "online" } },
    { method: "POST", path: "/api/laudo-sintetico/presence", body: { presence: "typing" } },
    { method: "POST", path: "/api/laudo-sintetico/presence?x=1", body: { chatId: "15550000001@c.us", presence: "typing" } },
    { method: "POST", path: "/api/nao-previsto", body: {} },
    { method: "POST", path: "/api/laudo-sintetico/presence", body: "x".repeat(100_001) },
  ])("continua recusando operação ou corpo fora do contrato ($method $path)", async pedido => {
    const r = await comReceiverReal(async (_client, origem) => {
      const response = await fetch(origem + pedido.path, {
        method: pedido.method,
        headers: { "content-type": "application/json" },
        body: typeof pedido.body === "string" ? pedido.body : pedido.body === undefined ? undefined : JSON.stringify(pedido.body),
      });
      expect(response.status).toBe(500);
    });
    expect(r.falhasHttp).toEqual(["operação WAHA inesperada"]);
    expect(r.entregas).toEqual([]);
  });
});
