/**
 * A ETIQUETA DE CONTATO INTERNO BARRA OS DOIS ENVIOS QUE NÃO PASSAM PELO GATE (#2353).
 *
 * O gate de elegibilidade (`lib/ai/elegibilidade/gate.ts`) barra o passo de
 * mensagem por IA de quem tem etiqueta interna, e o nascimento do card
 * (`lib/leads/nascimento-do-lead.ts`) não cria negócio — mas o caso da issue
 * passa POR BAIXO dos dois: a pessoa escreve, o card nasce, um fluxo de
 * follow-up a inscreve, e só DEPOIS alguém põe a etiqueta "interno".
 *
 * Sobravam dois caminhos onde o envio automático continuava saindo:
 *
 *   1. `isLeadInHandoff` (`lib/agent-engine/agent/human-handoff.ts`) — o guarda
 *      que o envio FIXO do follow-up e o modelo aprovado do worker leem ANTES de
 *      qualquer gate;
 *   2. `readStopFlags` (`lib/agent-engine/guardrails/before-send.ts`) — o gate
 *      `stop` da cadeia, a segunda camada do mesmo envio.
 *
 * Os dois são SQL direto contra `contacts` e liam só `force_human`, `is_personal`
 * e `ai_opt_out`: nenhum dos dois enxergava `contacts.tags` contra
 * `organizations.settings.crm.internal_contact_tags`.
 *
 * ─── Por que aqui, e não num teste de unidade ────────────────────────────────
 *
 * As duas funções REAIS rodam contra Postgres de verdade, pelo `pg.Pool` — não
 * há cópia do SQL no teste (transcrever o predicado aqui mediria o teste contra
 * ele mesmo) nem dublê que apaga a função. É por isso que este arquivo vive na
 * suíte de invariantes: ele precisa do banco do baseline.
 *
 * ─── SABOTAGEM (a catraca) ──────────────────────────────────────────────────
 *
 * · Tirar a cláusula da etiqueta de `isLeadInHandoff`: "a etiqueta interna barra
 *   o turno" cai (o guarda volta a responder false para o contato etiquetado).
 * · Tirar a cláusula de `readStopFlags`: "a etiqueta interna para o envio" cai.
 * · Trocar o motivo do veto por `contato_bloqueado` fixo: "o motivo é
 *   'contato_interno'" cai — o caso existe porque dizer "optou por sair" para
 *   quem só está na lista interna é mentir sobre o motivo.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { readStopFlags } from "@/lib/agent-engine/guardrails/before-send";
import { ehContatoInterno } from "@/lib/contacts/tags-internas";

/** O container publica em 127.0.0.1:${TEST_DB_PORT} (scripts/test-db.sh). */
const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 2,
});

/**
 * Fixtures PRÓPRIAS (nada do `seedGov`): este arquivo escreve `settings` de
 * organização e `tags` de contato, e plantar isso nas linhas compartilhadas
 * faria os vizinhos da suíte lerem um estado que não é deles. `fileParallelism:
 * false` + banco novo por arquivo ⇒ ninguém colide, mas a lição da #207 fica.
 */
const ORG_INTERNA = "dddddddd-2353-4000-8000-000000000101";
const ORG_COMUM = "dddddddd-2353-4000-8000-000000000102";

/** Etiqueta escrita à mão: maiúsculas e espaço nas pontas, de propósito. */
const CONTATO_MISTA = "dddddddd-2353-4000-8000-000000000201";
/** Etiqueta que NÃO está na lista da organização. */
const CONTATO_ALHEIO = "dddddddd-2353-4000-8000-000000000202";
/** Mesma etiqueta, mas numa organização que não configurou lista nenhuma. */
const CONTATO_FORA_DA_LISTA = "dddddddd-2353-4000-8000-000000000203";
/** Controle positivo do MOTIVO: parado por bloqueio, não por etiqueta. */
const CONTATO_BLOQUEADO = "dddddddd-2353-4000-8000-000000000204";

/** A lista da org, com espaço nas pontas de propósito (os DOIS lados normalizam). */
const LISTA_INTERNA = [" Interno ", "Equipe"];

beforeAll(async () => {
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name, settings)
       values ('${ORG_INTERNA}', 'gov-inv-interno', 'Org Interna', 'Interna',
               '{"crm":{"internal_contact_tags":[" Interno ","Equipe"]}}'::jsonb),
              ('${ORG_COMUM}', 'gov-inv-comum', 'Org Comum', 'Comum', '{}'::jsonb)
       on conflict do nothing;
     insert into public.contacts (id, organization_id, display_name, tags, is_blocked)
       values ('${CONTATO_MISTA}', '${ORG_INTERNA}', 'Contato da equipe', array['  iNtErNo  '], false),
              ('${CONTATO_ALHEIO}', '${ORG_INTERNA}', 'Cliente', array['cliente vip'], false),
              ('${CONTATO_FORA_DA_LISTA}', '${ORG_COMUM}', 'Cliente da outra org', array['interno'], false),
              ('${CONTATO_BLOQUEADO}', '${ORG_INTERNA}', 'Bloqueado', array['cliente vip'], true)
       on conflict do nothing;`,
  );

  // Controle positivo do instrumento: sem isto, um pool que conectasse no banco
  // ERRADO faria toda asserção falhar por ausência de linha em vez de por
  // comportamento — e um pool que não conecta faria o arquivo explodir antes de
  // medir nada.
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from public.organizations where id = $1`,
    [ORG_INTERNA],
  );
  if (rows[0]?.n !== "1") {
    throw new Error(
      `o pool não está no banco que o setupFile preparou (porta ${PORTA}): org de fixture ausente`,
    );
  }
});

afterAll(async () => {
  await pool.end();
});

async function etiquetasDe(contato: string): Promise<string[]> {
  const { rows } = await pool.query<{ tags: string[] | null }>(
    `select tags from public.contacts where id = $1`,
    [contato],
  );
  return rows[0]?.tags ?? [];
}

describe("isLeadInHandoff — o guarda que o envio fixo do worker lê primeiro", () => {
  it("a etiqueta interna barra o turno, e a régua normaliza os DOIS lados", async () => {
    // A etiqueta guardada é `  iNtErNo  ` e a lista tem ` Interno `: casar aqui
    // é a MESMA régua do gate (trim + minúscula), não uma comparação exata.
    await expect(isLeadInHandoff(pool, ORG_INTERNA, CONTATO_MISTA)).resolves.toBe(true);

    // O mesmo par, pela régua em JS: as duas formas têm de concordar — se
    // divergirem, a tela (que usa a de JS) e o worker (que usa a de SQL) passam
    // a dizer coisas diferentes sobre o mesmo contato.
    expect(ehContatoInterno(await etiquetasDe(CONTATO_MISTA), LISTA_INTERNA)).toBe(true);
  });

  it("etiqueta que não está na lista não barra nada (controle negativo)", async () => {
    await expect(isLeadInHandoff(pool, ORG_INTERNA, CONTATO_ALHEIO)).resolves.toBe(false);
    expect(ehContatoInterno(await etiquetasDe(CONTATO_ALHEIO), LISTA_INTERNA)).toBe(false);
  });

  it("a lista é da ORGANIZAÇÃO: a mesma etiqueta não barra em quem não configurou", async () => {
    await expect(isLeadInHandoff(pool, ORG_COMUM, CONTATO_FORA_DA_LISTA)).resolves.toBe(false);
  });
});

describe("readStopFlags — o gate `stop` da cadeia before_send", () => {
  it("a etiqueta interna para o envio, com motivo 'contato_interno'", async () => {
    await expect(readStopFlags(pool, ORG_INTERNA, CONTATO_MISTA)).resolves.toEqual({
      stopped: true,
      motivo: "contato_interno",
    });
  });

  it("o motivo continua 'contato_bloqueado' quando o que para é bloqueio", async () => {
    // Sem este caso, um `motivo: 'contato_interno'` fixo passaria nos dois testes
    // acima e diria "contato interno" para um contato que só está bloqueado.
    await expect(readStopFlags(pool, ORG_INTERNA, CONTATO_BLOQUEADO)).resolves.toEqual({
      stopped: true,
      motivo: "contato_bloqueado",
    });
  });

  it("etiqueta fora da lista e organização sem lista não param o envio", async () => {
    await expect(readStopFlags(pool, ORG_INTERNA, CONTATO_ALHEIO)).resolves.toEqual({
      stopped: false,
      motivo: null,
    });
    await expect(readStopFlags(pool, ORG_COMUM, CONTATO_FORA_DA_LISTA)).resolves.toEqual({
      stopped: false,
      motivo: null,
    });
  });

  it("o ramo do ENCONTRO (comando de um humano) segue sem a etiqueta interna", async () => {
    // A feature promete que a conversa segue normal na Inbox, inclusive para o
    // envio manual: a etiqueta interna NÃO pode calar o caminho do operador —
    // mesmo desenho do `ai_opt_out`, que também só vive no outro ramo.
    await expect(readStopFlags(pool, ORG_INTERNA, CONTATO_MISTA, true)).resolves.toEqual({
      stopped: false,
      motivo: null,
    });
  });
});
