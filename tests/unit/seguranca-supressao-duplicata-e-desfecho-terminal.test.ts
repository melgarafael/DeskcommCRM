/**
 * EVIDÊNCIA DE SEGURANÇA — regressões das superfícies sensíveis do caminho de
 * agente tocadas pelo gate near-dup (`followup-turn.ts` + `inbound-turn.ts`).
 *
 * As invariantes de `inbound-turn.ts` têm suíte própria (send-message-
 * duplicata-proxima); este arquivo consolida, nos DOIS arquivos, as propriedades
 * de SEGURANÇA transversais:
 *
 *  1. Supressão de duplicata NUNCA é marcada como entregue — no caminho do
 *     inbound: erro de ensino `ok:false` antes da cadeia, sem ledger.
 *  2. O follow-up fixo NÃO tem gate near-dup (#2996, item 2 — decisão do
 *     mantenedor): `sendFixedOutbound` protege promessas hoje indiretamente, via
 *     `runAgentTurn` → `send_message`, que já tem o gate em memória do turno.
 *     Sem gate aqui, texto fixo do OPERADOR no passo do fluxo e o re-envio de
 *     `{{volta}}` num laço nunca somem silenciosamente. O contrato é ausência:
 *     o módulo não importa a régua nem a memória, e o desfecho distinto
 *     `duplicate_suppressed` deixou de existir.
 *  3. A janela de supressão é limitada: outbound desde a última inbound, com
 *     teto — nunca suprime a resposta futura a um cliente que falou de novo, e
 *     mensagem `failed` não bloqueia a próxima tentativa (#2996, item 4).
 *  4. Corpo vazio é estruturalmente indespachável (schema min(1)).
 *
 * (O contrato de desfecho terminal — o bloco de caso humano não pode despachar
 * nem re-tentar — é pinçado pela suíte de saída truncada/vazia persistente.)
 *
 * Técnica: contrato de fonte (mesma das suítes irmãs) — os executes são
 * closures sem ponto de injeção barato; o que se prende é a estrutura real.
 * A régua pura e a trava em-voo têm comportamento executável em near-dup.test.ts;
 * a janela de banco em memoria-envio-janela.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const inbound = ler("lib/agent-engine/agent/inbound-turn.ts");
const followup = ler("lib/agent-engine/agent/followup-turn.ts");
const memoria = ler("lib/agent-engine/agent/memoria-envio.ts");

// ─── follow-up fixo: SEM gate near-dup (#2996, item 2) ──────────────────────
describe("follow-up fixo não tem gate near-dup (decisão mantida e documentada)", () => {
  it("o módulo não importa a régua pura nem a memória de janela", () => {
    expect(followup).not.toContain("encontraDuplicado");
    expect(followup).not.toContain("corposEnviadosDesdeUltimaInbound");
    expect(followup).not.toContain("from './near-dup'");
    expect(followup).not.toContain("from './memoria-envio'");
  });

  it("o desfecho `duplicate_suppressed` deixou de existir no tipo e no consumo", () => {
    expect(followup).not.toContain("duplicate_suppressed");
    expect(followup).toMatch(
      /type EnvioFixoDesfecho =\s*\| \{ kind: "sent" \}\s*\| \{ kind: "deferred"; until: Date; reason: string \}\s*\| \{ kind: "skipped" \};/,
    );
  });

  it("texto do operador no passo do fluxo e laço `{{volta}}` nunca são bloqueados", () => {
    // O caminho fixo (handoff-skip → getLeadContext → cadeia → despacho) não
    // contém NENHUMA comparação de conteúdo: nada de supressão implícita entre
    // o texto escolhido pelo operador e o envio.
    const iHandoff = followup.indexOf("isLeadInHandoff(pool, tenantId, leadId,");
    const iDespacho = followup.indexOf("const context = await getLeadContext(", iHandoff);
    expect(iHandoff).toBeGreaterThan(-1);
    expect(iDespacho).toBeGreaterThan(iHandoff);
    const caminhoFixo = followup.slice(iHandoff, iDespacho);
    expect(caminhoFixo).not.toContain("encontraDuplicado");
    expect(caminhoFixo).not.toContain("corposEnviadosDesdeUltimaInbound");
    // A decisão fica escrita no próprio caminho — quem mexer aqui lê por quê.
    expect(caminhoFixo).toContain("{{volta}}");
    expect(caminhoFixo).toContain("SEM gate near-dup AQUI (#2996, item 2");
  });

  it("a proteção de re-resposta de promessa segue apontando para o gate do turno", () => {
    // Follow-up de promessa roda por runAgentTurn → send_message, cujo gate em
    // memória do turno (semeado com a janela) cobre a quase-repetição.
    expect(followup).toContain("runAgentTurn");
    expect(inbound).toContain("dupTrava.checar(body)");
    expect(inbound).toContain("corposEnviadosDesdeUltimaInbound(");
  });
});

// ─── invariantes transversais nos dois arquivos sensiveis ───────────────────
describe("nunca entregue e nunca despachado fora do contrato, nos dois caminhos", () => {
  it("inbound: a supressão vem ANTES da cadeia de despacho e antes de qualquer outcome", () => {
    const gi = inbound.indexOf("dupTrava.checar(body)");
    expect(gi).toBeGreaterThan(-1);
    const ri = inbound.indexOf("runBeforeSend(", gi);
    expect(ri).toBeGreaterThan(gi);
    // Entre a supressão e a cadeia não há registro de outcome: um veto não é
    // resposta e não pode virar entrega (nem ledger, nem contagem de envio).
    expect(inbound.slice(gi, ri)).not.toContain("outcomes.push");
  });

  it("corpo vazio é estruturalmente indespachável (schema min(1))", () => {
    expect(inbound).toMatch(/body: z\.string\(\)\.min\(1\)\.describe\(/);
  });

  it("a janela de supressão é limitada: outbound desde a última inbound, com teto", () => {
    // Corte na inbound mais nova: cliente que falou de novo sai da janela e a
    // resposta legítima dele nunca é suprimida; só outbound conta, com teto.
    expect(memoria).toContain("export async function corposEnviadosDesdeUltimaInbound(");
    expect(memoria).toContain("direction = 'inbound'");
    expect(memoria).toContain("direction = 'outbound'");
    expect(memoria).toContain("limit $4");
    expect(memoria).toMatch(/LIMITE_PADRAO = 15/);
  });

  it("mensagem `failed` fica de FORA da janela — falha não bloqueia a próxima tentativa (#2996, item 4)", () => {
    // Só o `'failed'` explícito é excluído: status nulo (linha antiga) ou outro
    // estado segue contando. O corte temporal da inbound também está no WHERE
    // (a sabotagem `and true` do mantenedor derruba os dois asserts seguintes).
    expect(memoria).toContain("and coalesce(m.status, '') <> 'failed'");
    expect(memoria).toContain("m.created_at > coalesce(u.em, '-infinity'::timestamptz)");
    expect(memoria).toContain("m.created_at > now() - ($3::bigint * interval '1 millisecond')");
  });
});
