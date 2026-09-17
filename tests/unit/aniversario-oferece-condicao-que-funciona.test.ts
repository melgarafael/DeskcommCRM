/**
 * A CONDIÇÃO QUE A TELA OFERECE PARA O ANIVERSÁRIO CASA DE VERDADE.
 *
 * ## O defeito de que esta cerca é irmã
 *
 * O PR #784 deixou um defeito exatamente com esta forma, consertado por
 * `tests/unit/agenda-gatilho-leva-o-tipo-real.test.ts`: o editor de regras
 * oferecia "Tipo de atendimento contém …" para os quatro gatilhos de agenda, e
 * três dos quatro emissores mandavam `nomeDoTipo: "Agendamento"` cravado. A
 * condição existia na tela, era salva, e NUNCA casava. Controle decorativo é
 * pior que controle ausente: a pessoa acredita que configurou.
 *
 * O gatilho `contact.birthday` acrescenta uma oferta da mesma forma — o
 * `RuleEditor` promete, para ele, "Tags do contato contém …" e "Nome do contato
 * contém …" (`CONTACT_FIELDS`). Esta cerca responde à pergunta que a triagem do
 * #784 obriga a fazer: *o aniversário repete o padrão?*
 *
 * ## Onde a sonda olha — no EFEITO, e pelas peças REAIS
 *
 * Não reimplementa o contexto. Roda o `buildContext` de verdade
 * (`lib/automation/engine.ts`) sobre a linha de `event_log` que o cron
 * `contact-birthdays` realmente emite, e depois passa a condição pelo
 * `evaluateConditions` de verdade (`lib/automation/conditions.ts`) — o mesmo par
 * que o motor usa em produção. Uma sonda que montasse o contexto à mão provaria
 * só que eu sei escrever um objeto.
 *
 * ## As três maneiras de o aniversário ficar decorativo
 *
 *  1. o cron emite `entity_kind` que não é `contact` → `buildContext` cai fora
 *     do ramo e `context.contact` nunca existe;
 *  2. `ENTIDADE_ESPERADA_POR_GATILHO["contact.birthday"]` diverge do que o cron
 *     emite → o motor DESCARTA o evento antes de avaliar qualquer condição;
 *  3. o campo oferecido aponta para um caminho que o contexto não tem
 *     (`contact.nome` em vez de `contact.name`, por exemplo).
 *
 * As três estão medidas. E os campos NÃO são digitados aqui: saem lidos do
 * próprio `RuleEditor.tsx`, senão a cerca mede a minha cópia deles em vez de
 * medir a tela.
 *
 * ## Comando
 *
 *     npx vitest run tests/unit/aniversario-oferece-condicao-que-funciona.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildContext } from "@/lib/automation/engine";
import { evaluateConditions, resolveField } from "@/lib/automation/conditions";
import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";

/** A tag que separa "quem é cliente" de "quem é curioso" — o caso real. */
const TAG = "cliente";
const NOME = "Marisa Fontenelle";

/** A linha de `contacts` que o cron encontrou fazendo aniversário. */
const LINHA_DO_CONTATO = {
  id: CONTATO,
  organization_id: ORG,
  name: NOME,
  tags: [TAG, "vip"],
  birthdate: "1990-09-14",
  birthday_md: 914,
};

/**
 * Dublê mínimo do admin client: responde `contacts` e mais nada. Qualquer outra
 * tabela devolve `null`, então um `buildContext` que fosse buscar noutro lugar
 * apareceria como contexto vazio em vez de passar despercebido.
 */
function cliente(linha: Record<string, unknown> | null): SupabaseClient {
  return {
    from: (tabela: string) => ({
      select: () => {
        const cadeia: Record<string, unknown> = {};
        for (const m of ["eq", "neq", "in", "is", "order", "limit"]) cadeia[m] = () => cadeia;
        cadeia.maybeSingle = async () => ({
          data: tabela === "contacts" ? linha : null,
          error: null,
        });
        return cadeia;
      },
    }),
  } as unknown as SupabaseClient;
}

const CRON = path.join(process.cwd(), "app/api/v1/cron/contact-birthdays/route.ts");

/**
 * O `p_entity_kind` que o cron REALMENTE passa ao `emit_event`, lido da fonte.
 *
 * Digitar `"contact"` aqui mediria a minha cópia do cron, não o cron: se alguém
 * trocar o que ele emite, o dublê continuaria montando o evento certo e a cerca
 * ficaria verde sobre um sistema quebrado. Lendo, a ponta do emissor entra na
 * medição.
 */
function entidadeQueOCronEmite(): string | null {
  const m = /p_entity_kind:\s*"([^"]+)"/.exec(readFileSync(CRON, "utf8"));
  return m === null ? null : m[1]!;
}

/** O `p_event_type` que o cron passa ao `emit_event`, pelo mesmo motivo. */
function gatilhoQueOCronEmite(): string | null {
  const m = /p_event_type:\s*"([^"]+)"/.exec(readFileSync(CRON, "utf8"));
  return m === null ? null : m[1]!;
}

/**
 * A linha que o cron `app/api/v1/cron/contact-birthdays/route.ts` emite, campo
 * por campo como ele chama `emit_event` — com o tipo e a entidade LIDOS dele.
 */
function eventoDeAniversario(): EventRow {
  return {
    id: "11111111-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: gatilhoQueOCronEmite(),
    entity_kind: entidadeQueOCronEmite(),
    entity_id: CONTATO,
    payload: { local_date: "2026-09-14" },
  } as unknown as EventRow;
}

/** Os campos que o `RuleEditor` oferece para o aniversário — lidos da fonte. */
function camposOferecidosParaOAniversario(): string[] {
  const fonte = readFileSync(
    path.join(process.cwd(), "app/app/webhooks/_components/RuleEditor.tsx"),
    "utf8",
  );
  // `"contact.birthday": CONTACT_FIELDS,` → descobre o nome da constante…
  const ligacao = /"contact\.birthday":\s*([A-Z_]+)\s*,/.exec(fonte);
  if (ligacao === null) return [];
  // …e lê os `value:` do bloco dessa constante.
  const bloco = new RegExp(`const ${ligacao[1]}: CuratedField\\[\\] = \\[([\\s\\S]*?)\\];`).exec(
    fonte,
  );
  if (bloco === null) return [];
  return [...bloco[1]!.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("o gatilho de aniversário não oferece condição decorativa", () => {
  it("o parser está vivo — controle positivo antes de qualquer conclusão", () => {
    const campos = camposOferecidosParaOAniversario();
    expect(
      campos.length,
      "não li campo nenhum do RuleEditor: a sonda está cega e todo verde abaixo é falso",
    ).toBeGreaterThan(0);
    expect(campos).toContain("contact.tags");
    expect(
      entidadeQueOCronEmite(),
      "não achei `p_entity_kind` no cron `contact-birthdays`: a sonda perdeu o emissor de vista",
    ).not.toBeNull();
    expect(
      gatilhoQueOCronEmite(),
      "não achei `p_event_type` no cron `contact-birthdays`: a sonda perdeu o emissor de vista",
    ).not.toBeNull();
  });

  it("⭐ o cron emite o gatilho que a tela deixa escolher", () => {
    // O outro lado do mesmo par: um cron que emitisse `contact.aniversario`
    // produziria eventos que regra nenhuma assina — e o handler, que assina
    // `[...TRIGGER_EVENTS]`, nem seria chamado.
    expect(
      gatilhoQueOCronEmite(),
      "o cron emite um event_type que não está entre os gatilhos oferecidos: o evento nasce e nenhum handler o assina",
    ).toBe("contact.birthday");
  });

  it("⭐ o motor não descarta o evento: a entidade que o cron emite é a esperada", () => {
    // Se estes dois divergirem, nenhuma condição chega a ser avaliada — o motor
    // larga o evento antes disso, sem erro e sem log.
    expect(
      ENTIDADE_ESPERADA_POR_GATILHO["contact.birthday"],
      "o gatilho espera uma entidade diferente da que o cron `contact-birthdays` emite: a regra é salva, o aniversário chega, e o motor descarta o evento calado",
    ).toBe(eventoDeAniversario().entity_kind);
  });

  it("⭐ TODO campo oferecido para o aniversário chega a algum valor no contexto real", async () => {
    const contexto = await buildContext(cliente(LINHA_DO_CONTATO), eventoDeAniversario());

    // `resolveField` é o mesmo resolvedor que o avaliador usa. Campo que não
    // resolve devolve `undefined` — e, pelo contrato de `matches`, uma condição
    // sobre ele é sempre falsa: decorativa.
    const mortos = camposOferecidosParaOAniversario().filter(
      (campo) => resolveField(contexto, campo) === undefined,
    );

    expect(
      mortos,
      "o editor oferece, para o aniversário, campo que não existe no contexto que o motor monta: a condição é salva e nunca casa",
    ).toEqual([]);
  });

  it("⭐ 'Tags do contato contém cliente' CASA — é a condição do caso real", async () => {
    const contexto = await buildContext(cliente(LINHA_DO_CONTATO), eventoDeAniversario());

    expect(
      evaluateConditions([{ field: "contact.tags", op: "contains", value: TAG }], contexto),
      "a organização que quis parabenizar só quem é cliente escreveu uma regra que nunca dispara: a condição está na tela, foi salva, e o contexto do aniversário não tem as tags do contato",
    ).toBe(true);
  });

  it("⭐ 'Nome do contato contém …' CASA — o outro campo que a tela promete", async () => {
    const contexto = await buildContext(cliente(LINHA_DO_CONTATO), eventoDeAniversario());

    expect(
      evaluateConditions([{ field: "contact.name", op: "contains", value: "Fontenelle" }], contexto),
      "o nome do contato não chega ao contexto do aniversário: a condição que a tela oferece é decorativa",
    ).toBe(true);
  });

  it("a condição SEPARA — quem não tem a tag não passa (par de vacuidade)", async () => {
    // Sem este caso, um contexto em que tudo casasse por acaso deixaria os dois
    // ⭐ acima verdes provando nada.
    const contexto = await buildContext(cliente(LINHA_DO_CONTATO), eventoDeAniversario());

    expect(
      evaluateConditions([{ field: "contact.tags", op: "contains", value: "fornecedor" }], contexto),
      "a condição casa com qualquer tag: ela não filtra nada, e a régua dos casos acima não vale",
    ).toBe(false);
  });

  it("contato apagado entre o cron e o motor não derruba a avaliação", async () => {
    // O cron emite e o evento é consumido depois; nesse meio o contato pode ter
    // sumido. O contrato do avaliador é "campo ausente = condição falsa, nunca
    // erro" — a regra não roda, e ninguém explode.
    const contexto = await buildContext(cliente(null), eventoDeAniversario());

    expect(contexto.contact).toBeUndefined();
    expect(
      evaluateConditions([{ field: "contact.tags", op: "contains", value: TAG }], contexto),
    ).toBe(false);
  });
});
