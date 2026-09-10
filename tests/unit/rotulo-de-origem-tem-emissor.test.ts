/**
 * O BALÃO NÃO OFERECE RÓTULO QUE O SISTEMA NUNCA PRODUZ — NEM CALA UM QUE PRODUZ.
 *
 * ## O defeito, medido no PR #631 (2026-09-08)
 *
 * `MessageBubble` passou a nomear a origem de cada mensagem enviada a partir de
 * `messages.sent_via`. Quatro dos cinco rótulos casam com um valor que alguém
 * de fato grava. Um não:
 *
 *   grep -rn 'sent_via:' --include='*.ts' app lib workers | grep -v '\.test\.'
 *     app/api/v1/messages/_handler.ts:529  → 'ai' | 'user'
 *     lib/waha/ingest.ts:622, :850         → 'external_device'
 *     lib/channels/zernio/ingest.ts:480    → 'external_device'
 *     workers/ai-response-worker.ts:1068   → 'ai'
 *     (mais o DEFAULT 'crm' da coluna, em supabase/baseline.sql)
 *
 * **Ninguém grava `'automation'`.** O CHECK do banco aceita o valor, o tipo em
 * `lib/types/messaging.ts` o declara, o componente tem um ramo para ele — e
 * nenhuma linha de `messages` pode chegar nele. O rótulo "Automação" é
 * inalcançável.
 *
 * E a consequência não é só código morto. As ações de automação
 * (`lib/automation/actions/send-whatsapp.ts`, `send-ai-message.ts`) chamam
 * `sendMessageHandler` com `actor: { type: "webhook_source" }`, e a linha 529 é
 * `ctx.actor.type !== "user" ? "ai" : "user"` — então o que a automação envia é
 * carimbado `'ai'` e o balão mostra **"IA"**. Um template fixo de uma regra
 * aparece para o dono como se o agente de IA o tivesse escrito.
 *
 * ## Por que um guarda, e não uma conferida no diff
 *
 * É a classe do "controle decorativo": a tela OFERECE o que o motor nunca
 * produz. Ela não deixa vermelho em lugar nenhum — nem tipo, nem lint, nem
 * teste de componente, porque o teste de componente **constrói o objeto à mão**
 * e pode passar qualquer valor do union. O teste que o PR trouxe faz
 * exatamente isso (`msg({ sent_via: "automation" })`) e fica verde: ele prova
 * que o RENDER sabe desenhar o rótulo, nunca que algum dado chega nele.
 *
 * A propriedade só é decidível olhando as DUAS pontas ao mesmo tempo — quem
 * escreve a coluna e quem a lê —, e as duas são enumeráveis a partir do
 * repositório. É a mesma régua de `cron-audita-so-quando-ha-efeito`: varre a
 * fonte em vez de manter lista, então alcança emissor que ainda não existe.
 *
 * ## As duas direções, e por que as duas precisam existir
 *
 * Só "todo rótulo tem emissor" seria satisfeito pelo conserto degenerado
 * *apagar todos os rótulos* — que é o defeito de volta, na direção de que
 * ninguém reclama. Por isso o irmão: "todo valor emitido tem rótulo".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Onde o rótulo é decidido. */
const COMPONENTE = path.join(RAIZ, "components", "inbox", "MessageBubble.tsx");

/**
 * Onde a coluna pode ser ESCRITA. `tests/` fora de propósito: um fixture pode
 * inventar qualquer valor do union sem que o produto o produza — foi
 * exatamente essa a confusão que este guarda existe para desfazer.
 */
const AREAS_DE_ESCRITA = ["app", "lib", "workers"];

const BASELINE = path.join(RAIZ, "supabase", "baseline.sql");

/**
 * Valores que o produto NÃO emite hoje e que, mesmo assim, podem ser rotulados.
 *
 * Lista que só encolhe. Entrada nova precisa do argumento de por que a linha
 * existe no banco sem ninguém a escrever pelo código — legado, dado importado,
 * default de coluna. "Vai ser usado um dia" não serve: é justamente a forma do
 * defeito que originou este arquivo.
 */
const ROTULO_SEM_EMISSOR_DE_PROPOSITO: Record<string, string> = {};

/**
 * Valores emitidos que NÃO levam rótulo, com o motivo.
 *
 * `system` não está aqui porque ninguém o emite — se algum dia alguém emitir,
 * o teste da segunda direção cobra o rótulo, e é isso que se quer.
 */
const EMISSOR_SEM_ROTULO_DE_PROPOSITO: Record<string, string> = {};

function lerArquivos(dir: string): string[] {
  const saida: string[] = [];
  const pilha = [dir];
  while (pilha.length > 0) {
    const atual = pilha.pop()!;
    for (const entrada of readdirSync(atual)) {
      if (entrada === "node_modules" || entrada === ".next") continue;
      const p = path.join(atual, entrada);
      if (statSync(p).isDirectory()) {
        pilha.push(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entrada)) continue;
      if (/\.test\.(ts|tsx)$/.test(entrada)) continue;
      saida.push(p);
    }
  }
  return saida;
}

/** Os valores que o componente sabe NOMEAR: `message.sent_via === "X"`. */
function rotulosOferecidos(): Set<string> {
  const src = readFileSync(COMPONENTE, "utf8");
  const re = /sent_via\s*===\s*"([a-z_]+)"/g;
  const s = new Set<string>();
  for (const m of src.matchAll(re)) s.add(m[1]!);
  return s;
}

/** Os valores que alguma linha de produção ESCREVE: `sent_via: "X"`. */
function valoresEmitidos(): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  for (const area of AREAS_DE_ESCRITA) {
    for (const arquivo of lerArquivos(path.join(RAIZ, area))) {
      const src = readFileSync(arquivo, "utf8");
      for (const m of src.matchAll(/sent_via:\s*"([a-z_]+)"/g)) {
        const v = m[1]!;
        mapa.set(v, [...(mapa.get(v) ?? []), path.relative(RAIZ, arquivo)]);
      }
      // A forma ternária de `_handler.ts`: `sent_via: cond ? ("ai" as const) : ("user" as const)`
      for (const m of src.matchAll(/sent_via:[^\n]*?\?\s*\("([a-z_]+)"[^\n]*?:\s*\("([a-z_]+)"/g)) {
        for (const v of [m[1]!, m[2]!]) {
          mapa.set(v, [...(mapa.get(v) ?? []), path.relative(RAIZ, arquivo)]);
        }
      }
    }
  }
  return mapa;
}

/** O DEFAULT da coluna é um emissor: toda linha que omite `sent_via` cai nele. */
function defaultDaColuna(): string | null {
  const sql = readFileSync(BASELINE, "utf8");
  const m = /"sent_via"\s+"text"\s+DEFAULT\s+'([a-z_]+)'/.exec(sql);
  return m?.[1] ?? null;
}

/** O vocabulário que o banco ACEITA — o CHECK. */
function vocabularioDoBanco(): Set<string> {
  const sql = readFileSync(BASELINE, "utf8");
  const m = /CONSTRAINT "messages_sent_via_check" CHECK \(\("sent_via" = ANY \(ARRAY\[([^\]]+)\]/.exec(sql);
  if (m === null) return new Set();
  return new Set([...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!));
}

const oferecidos = rotulosOferecidos();
const emitidos = valoresEmitidos();
const padrao = defaultDaColuna();
const vocabulario = vocabularioDoBanco();
const produzidos = new Set<string>([...emitidos.keys(), ...(padrao ? [padrao] : [])]);

describe("o rótulo de origem do balão", () => {
  it("os quatro extratores estão vivos — controle positivo antes de concluir", () => {
    // Sem isto, um regex que parou de casar devolve conjunto vazio e as duas
    // asserções abaixo passam por VACUIDADE. É o modo de falha 7 da triagem:
    // grep vazio é indistinguível de instrumento morto.
    expect(oferecidos.size, `nenhum \`sent_via === "…"\` em ${COMPONENTE}`).toBeGreaterThan(0);
    expect(emitidos.size, "nenhum `sent_via: \"…\"` em app/, lib/ ou workers/").toBeGreaterThan(0);
    expect(padrao, "DEFAULT de messages.sent_via não encontrado no baseline").not.toBeNull();
    expect(vocabulario.size, "CHECK messages_sent_via_check não encontrado").toBeGreaterThan(0);

    // E as âncoras concretas: se a fonte mudar de forma, isto estoura em vez de
    // devolver silêncio. O piso é bem abaixo do medido em 2026-09-08 (5 rótulos
    // oferecidos, 3 valores emitidos, 6 no vocabulário) para não reprovar o
    // próximo PR que mova um arquivo de lugar.
    expect(oferecidos.has("ai"), "o rótulo da IA sumiu do componente").toBe(true);
    expect(emitidos.has("external_device"), "ninguém mais grava external_device?").toBe(true);
  });

  it("todo rótulo que a tela oferece corresponde a um valor que alguém GRAVA", () => {
    const orfaos = [...oferecidos]
      .filter((v) => !produzidos.has(v))
      .filter((v) => !(v in ROTULO_SEM_EMISSOR_DE_PROPOSITO));

    expect(
      orfaos,
      `MessageBubble nomeia ${JSON.stringify(orfaos)}, mas nenhuma linha de ` +
        `app/, lib/ ou workers/ grava esse valor em messages.sent_via, e ele não ` +
        `é o DEFAULT da coluna ('${padrao}'). Um rótulo que o dado nunca produz é ` +
        `controle decorativo: a tela promete uma distinção que o motor não faz. ` +
        `Emissores achados: ${JSON.stringify([...produzidos].sort())}.`,
    ).toEqual([]);
  });

  it("todo valor que alguém grava tem rótulo — senão a distinção morre calada", () => {
    // O irmão da asserção acima. Sem ele, "apagar todos os rótulos" satisfaria
    // o teste e devolveria o defeito original: a bolha sem nome, com o dono
    // lendo tudo como se tivesse sido digitado no CRM.
    const mudos = [...produzidos]
      .filter((v) => !oferecidos.has(v))
      .filter((v) => !(v in EMISSOR_SEM_ROTULO_DE_PROPOSITO));

    expect(
      mudos,
      `estes valores chegam a messages.sent_via e o balão não os nomeia: ` +
        `${JSON.stringify(mudos)}. Emitidos por: ` +
        JSON.stringify(Object.fromEntries([...emitidos].map(([k, v]) => [k, [...new Set(v)]]))),
    ).toEqual([]);
  });

  it("todo rótulo oferecido é um valor que o BANCO aceita", () => {
    // Um ramo para um valor fora do CHECK é inalcançável por construção, e a
    // leitura do componente não denuncia — o union do TypeScript e o CHECK do
    // Postgres são dois vocabulários que ninguém casa.
    const foraDoCheck = [...oferecidos].filter((v) => !vocabulario.has(v));
    expect(
      foraDoCheck,
      `o componente nomeia ${JSON.stringify(foraDoCheck)}, que o CHECK ` +
        `messages_sent_via_check recusa (${JSON.stringify([...vocabulario].sort())}).`,
    ).toEqual([]);
  });
});
