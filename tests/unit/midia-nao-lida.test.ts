/**
 * A MÍDIA QUE O AGENTE NÃO CONSEGUE LER PRECISA APARECER.
 *
 * O cliente mandava foto ou áudio e o agente respondia como se nada tivesse
 * chegado. A derivação devolvia `""` em silêncio quando o modelo não enxerga
 * imagem, ou quando falta a chave de transcrição.
 *
 * O que torna esse defeito caro não é a mídia perdida — é a ausência de
 * qualquer rastro. Sem erro, sem log, sem aviso, o operador não tem por onde
 * começar; o sintoma que ele vê ("o agente ignorou meu cliente") é
 * indistinguível de "o agente é ruim". Por isso a correção tem DOIS lados, e
 * este arquivo guarda os dois:
 *
 *  - o **agente** precisa saber que recebeu algo que não interpretou, para
 *    poder pedir em texto em vez de silenciar;
 *  - o **operador** precisa de um aviso com o que fazer.
 *
 * Guardar só um deixaria metade do problema de pé.
 */
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MARCADOR_NAO_LIDA } from "@/workers/media-derive-worker";
import { KIND_LABEL, kindLabel } from "@/lib/ai/agent-inbox-copy";

describe("o marcador que o agente recebe", () => {
  it("não é string vazia — é o que distingue 'não li' de 'veio vazio'", () => {
    // A regressão a temer é alguém "simplificar" isto de volta para "".
    expect(MARCADOR_NAO_LIDA.trim().length).toBeGreaterThan(0);
  });

  it("está em português e diz que houve uma mídia", () => {
    // O texto entra no contexto do modelo. Um marcador técnico
    // (`[MEDIA_UNREADABLE]`) faria o agente ecoar jargão ao cliente.
    expect(MARCADOR_NAO_LIDA.toLowerCase()).toContain("mídia");
    expect(MARCADOR_NAO_LIDA).not.toMatch(/[A-Z_]{6,}/);
  });

  it("não promete ao modelo algo que ele não pode fazer", () => {
    // "vou analisar depois" faria o agente prometer ao cliente um retorno que
    // ninguém agendou — a família de defeito que o guardrail de promessa existe
    // para barrar.
    expect(MARCADOR_NAO_LIDA.toLowerCase()).not.toMatch(/depois|em breve|analisar|vou /);
  });
});

describe("o aviso que o operador recebe", () => {
  it("o kind tem texto de gente na Central", () => {
    // Sem entrada aqui, o item apareceria na Central com o identificador cru.
    const copy = (KIND_LABEL as Record<string, string>)["midia_nao_lida"];
    expect(copy).toBeDefined();
    expect(copy!.length).toBeGreaterThan(10);
    // E o helper precisa devolvê-lo — KIND_LABEL preenchido com um kindLabel()
    // que não o consulta seria a mesma tela crua, com o mapa certo ao lado.
    expect(kindLabel("midia_nao_lida")).toBe(copy);
  });

  it("o texto descreve o que o CLIENTE viveu, não a causa técnica", () => {
    const copy = (KIND_LABEL as Record<string, string>)["midia_nao_lida"]!;
    expect(copy.toLowerCase()).toMatch(/foto|áudio|imagem|mídia/);
    expect(copy.toLowerCase()).not.toMatch(/null|undefined|api|token|whisper/);
  });
});

describe("o vocabulário do banco acompanha", () => {
  it("o kind está na constraint do baseline", () => {
    // O par TypeScript × banco é o eixo que este repo já viu divergir em
    // silêncio: o insert falharia com 23514 dentro de um caminho que engole
    // erro, e o aviso simplesmente não apareceria.
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const constraint = baseline.slice(
      baseline.lastIndexOf("add constraint agent_inbox_items_kind_check"),
    );
    expect(constraint.slice(0, 2000)).toContain("'midia_nao_lida'");
  });

  it("o severity que o worker escreve está na constraint do baseline", () => {
    // O kind estava certo e o SEVERITY não: o worker gravava `"warning"`, e o
    // CHECK aceita info|warn|critical. O INSERT era recusado com 23514, o
    // supabase-js devolve `{ error }` em vez de lançar, o `catch` nunca rodava —
    // e o aviso NUNCA abria. A Central ficava vazia exatamente no caso que esta
    // feature existe para tornar visível: sem erro, sem log, sem aviso.
    //
    // A asserção casa o LITERAL do worker contra a lista da constraint, não um
    // valor escrito à mão aqui — senão o teste guardaria a minha cópia.
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    const trecho = fonte.slice(fonte.indexOf('kind: "midia_nao_lida"'));
    const severityDoWorker = /severity:\s*"([a-z]+)"/.exec(trecho)?.[1];
    expect(
      severityDoWorker,
      "não achei o `severity:` do aviso de mídia no worker — o instrumento perdeu o alvo",
    ).toBeDefined();

    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const check = /severity text not null default '[a-z]+' check \(severity in \(([^)]*)\)\)/.exec(
      baseline,
    );
    expect(check, "não achei o CHECK de severity no baseline — instrumento cego").not.toBeNull();
    const aceitos = [...(check?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(aceitos.length, "a lista de severities veio vazia — instrumento cego").toBeGreaterThan(
      1,
    );
    expect(
      aceitos,
      `o worker grava severity="${severityDoWorker}", que o banco recusa — o aviso nunca abre`,
    ).toContain(severityDoWorker);
  });

  it("o worker CONFERE o retorno do insert do aviso — e só o 23505 é desfecho normal", () => {
    // `supabase-js` não lança em erro de banco: devolve `{ error }`. Enquanto o
    // retorno era descartado, a recusa era engolida, o worker devolvia "ok" e
    // nada era logado — um aviso que falha em silêncio é pior que aviso nenhum,
    // porque faz o próximo diagnóstico começar da premissa errada.
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    const trecho = fonte.slice(fonte.indexOf('kind: "midia_nao_lida"'));
    expect(trecho.slice(0, 2000), "o retorno do insert deixou de ser conferido").toMatch(
      /if \(error/,
    );
    // E a ÚNICA exceção é o código que o índice da 0527 levanta: o `select`
    // acima pergunta sem trava, então perder a corrida para o índice quer dizer
    // exatamente o que o aviso quer (já existe um aberto). Logar isso como
    // recusa de banco seria alarme falso em cima de um alarme correto.
    expect(
      trecho.slice(0, 2000),
      "o 23505 deixou de ser isentado — ou a isenção sumiu, ou o código mudou de número",
    ).toMatch(/error\.code !== "23505"/);
  });

  it("a constraint é reconstruída UMA vez só no baseline", () => {
    // A lição da issue #159: reconstruir a mesma constraint em N blocos faz o
    // último vencer e os valores dos anteriores sumirem sem ninguém notar.
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const ocorrencias = baseline.split("add constraint agent_inbox_items_kind_check").length - 1;
    expect(ocorrencias).toBe(1);
  });

  it("o aviso é único por organização aberta — na cadeia E no baseline (issue #880)", () => {
    // O dedupe deste aviso era uma PERGUNTA e uma ESCRITA separadas
    // (`workers/media-derive-worker.ts`: consulta "já existe aberto?" e insere
    // depois), e o lote de derivação roda em paralelo: dois workers leem "não
    // existe" antes de qualquer escrita e abrem dois avisos. O índice parcial é
    // a forma atômica do que o código já queria.
    const migracoes = readdirSync("supabase/migrations").filter((f) => /_0527_/.test(f));
    expect(migracoes.length, "a migration da 0527 não está no lugar").toBe(1);
    const migracao = readFileSync(`supabase/migrations/${migracoes[0]}`, "utf8");
    const baseline = readFileSync("supabase/baseline.sql", "utf8");

    // A CHAVE: (organização, kind) e NÃO o título — aqui o `select` já ignora o
    // `tipo` e quer um aviso por organização, ao contrário do `event_dead`, cujo
    // título entra na chave por causa das duas famílias que convivem abertas.
    const indice =
      /create unique index if not exists (\w+)\s+on public\.agent_inbox_items \(([^)]*)\)\s+where ([^;]*);/.exec(
        migracao,
      );
    expect(indice, "não achei o índice parcial na migration — instrumento cego").not.toBeNull();
    expect(indice![2]!.replace(/\s+/g, " ").trim()).toBe("organization_id, kind");
    expect(indice![3]!.replace(/\s+/g, " ").trim()).toBe(
      "status = 'open' and kind = 'midia_nao_lida'",
    );
    expect(baseline, "o índice não chegou ao baseline — o self-host não recebe").toContain(
      indice![1]!,
    );
    // E o bloco do baseline é o MESMO texto (o `install.sh` aplica só ele).
    expect(baseline).toContain(indice![0]!.trim());
  });
});
