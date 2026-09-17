/**
 * O AVISO na Central quando o assistente esbarra na etapa de perda (issue #917).
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE ═══
 *
 * O ponto de uso do caminho da IA (`lib/agent-engine/agent/inbound-turn.ts`,
 * a ferramenta `update_lead_state`) decidia o texto do aviso num encadeado de
 * `if` dentro do próprio handler. Medido: apagar o ramo de `perda_sem_motivo`
 * inteiro deixava **ZERO** caso vermelho em toda a suíte — a execução caía no
 * ramo genérico, que TAMBÉM grava um item de caixa, e nada distinguia os dois.
 *
 * Só que o item genérico diz "Espelho de stage no CRM falhou — funil
 * possivelmente inconsistente" e "Reconcilie o stage no CRM manualmente" — que é
 * literalmente a mensagem de incidente que a #917 veio eliminar. Nada quebrou; o
 * que falta é uma decisão de quem está no negócio. Mandar o dono reconciliar um
 * funil é pedir que ele procure um defeito que não existe.
 *
 * Dois ramos que gravam um item cada, com textos opostos, não se separam pela
 * pergunta "houve item?". Separam-se pelo TEXTO — e texto só vira asserção
 * quando a decisão é uma função que se pode chamar. Daí
 * `avisoDoEspelhoRecusado`, em `edge/crm/move-lead-stage`, junto do vocabulário
 * de motivos que ela traduz.
 *
 * O que fica congelado aqui:
 *  1. `perda_sem_motivo` produz o aviso de PERDA, e nunca o de incidente;
 *  2. `fora_do_escopo` continua com o aviso DELE (as duas recusas legítimas não
 *     se confundem: uma pede liberar um funil, a outra pede informar um motivo);
 *  3. motivo de incidente de verdade continua produzindo o aviso de incidente —
 *     senão o conserto viraria um jeito de calar o funil quebrado;
 *  4. warn-only não produz item nenhum.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  abreAvisoDoEspelhoRecusado,
  avisoDoEspelhoRecusado,
} from "@/lib/agent-engine/edge/crm/move-lead-stage";

const ETAPA = "Perdido";

describe("a etapa de perda sem motivo vira AÇÃO para o humano, não incidente", () => {
  it("o aviso fala em negócio PERDIDO e em informar o motivo", () => {
    const aviso = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "a etapa de destino fecha o negócio como perdido",
      etapaDeDestino: ETAPA,
    });

    expect(aviso).not.toBeNull();
    expect(aviso!.title.toLowerCase()).toContain("perdido");
    expect(aviso!.title.toLowerCase()).toContain("motivo");
    expect(aviso!.body).toContain("informe o motivo");
  });

  it("a instrução leva à ação que PERGUNTA o motivo — não ao arrasto, que devolve o card", () => {
    // Arrastar para a etapa de perda sem motivo é recusado pelo quadro ("Informe o
    // motivo da perda.") e o card volta. O aviso mandava "mova o card no board":
    // quem seguisse a instrução da Central batia exatamente nessa recusa.
    const aviso = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });
    const ACAO = "Marcar como perdido";

    expect(aviso!.body).toContain(`"${ACAO}"`);
    expect(aviso!.body).not.toMatch(/mova o card/i);
    // O rótulo citado é CONTRATO com a tela: renomear o item do menu sem mexer
    // aqui deixaria a Central mandando clicar num botão que não existe.
    const menu = readFileSync(
      join(process.cwd(), "components/kanban/KanbanCardActions.tsx"),
      "utf8",
    );
    expect(menu).toContain(`t("${ACAO}")`);
  });

  it("o aviso NÃO se repete a cada turno — e não engole o irmão do mesmo negócio", () => {
    // O assistente reconclui o mesmo passo em todo turno, e sem dedupe nasce uma
    // linha por mensagem do cliente: a queixa da #917 com outra roupa. O modo
    // importa e não é intercambiável — os DOIS avisos do espelho saem com o mesmo
    // `kind` genérico e a mesma `ref`, então `kind_e_ref` faria o segundo sumir
    // atrás do primeiro, e `kind_e_titulo` faria o aviso de um lead calar o do
    // lead seguinte. O efeito desse modo no SQL é medido contra Postgres em
    // tests/invariants/aviso-de-perda-nao-repete-nem-engole-o-irmao.test.ts.
    const perda = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });
    const escopo = avisoDoEspelhoRecusado({
      motivo: "fora_do_escopo",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });
    const incidente = avisoDoEspelhoRecusado({
      motivo: "crm_unavailable",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });

    expect(perda!.dedupe).toBe("kind_ref_e_titulo");
    expect(escopo!.dedupe).toBe("kind_ref_e_titulo");
    expect(incidente!.dedupe).toBe("kind_ref_e_titulo");
    // E os títulos são MESMO diferentes — se fossem iguais, o dedupe por título
    // engoliria um dos dois e este teste estaria medindo o nada.
    expect(perda!.title).not.toBe(escopo!.title);
  });

  it("e NÃO é o aviso de incidente — nada quebrou, não há o que reconciliar", () => {
    const aviso = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "a etapa de destino fecha o negócio como perdido",
      etapaDeDestino: ETAPA,
    });

    expect(aviso!.body).not.toContain("Reconcilie");
    expect(aviso!.title).not.toContain("Espelho de stage no CRM falhou");
    expect(aviso!.title).not.toContain("inconsistente");
  });

  it("diz para qual etapa o assistente quis levar o negócio", () => {
    // Sem o nome da etapa o dono não sabe QUAL perda o assistente enxergou, e o
    // aviso vira um pedido genérico de atenção.
    const aviso = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "…",
      etapaDeDestino: "Cancelado pelo paciente",
    });
    expect(aviso!.body).toContain("Cancelado pelo paciente");
  });
});

describe("as outras recusas continuam com o aviso delas", () => {
  it("`fora_do_escopo` pede liberar o funil, não informar motivo", () => {
    const aviso = avisoDoEspelhoRecusado({
      motivo: "fora_do_escopo",
      detalhe: "nenhum funil liberado para este assistente",
      etapaDeDestino: ETAPA,
    });

    expect(aviso!.title).toContain("funil que não é dele");
    expect(aviso!.body).toContain("nenhum funil liberado para este assistente");
    expect(aviso!.body).not.toContain("informe o motivo");
    expect(aviso!.body).not.toContain("Reconcilie");
  });

  it("incidente de verdade continua sendo incidente", () => {
    // A recusa de negócio não pode virar um jeito de calar o funil quebrado: o
    // banco fora do ar segue mandando reconciliar.
    const aviso = avisoDoEspelhoRecusado({
      motivo: "crm_unavailable",
      detalhe: "o banco do CRM não respondeu",
      etapaDeDestino: ETAPA,
    });

    expect(aviso!.title).toContain("Espelho de stage no CRM falhou");
    expect(aviso!.body).toContain("Reconcilie");
  });

  it("warn-only não produz item nenhum na Central", () => {
    for (const motivo of ["not_configured", "human_conflict"] as const) {
      expect(
        avisoDoEspelhoRecusado({ motivo, detalhe: "…", etapaDeDestino: ETAPA }),
        `esperava warn-only para ${motivo}`,
      ).toBeNull();
    }
  });
});

/**
 * O PONTO DE USO — quem GRAVA o aviso, e não só quem o decide.
 *
 * Enquanto o `inbound-turn` chamava `insertInboxItem` à mão com `aviso.dedupe`
 * no quarto argumento, apagar esse argumento deixava a suíte inteira verde: o
 * invariante de Postgres chama `insertInboxItem` direto, com o dedupe que ELE lê
 * da decisão. `abreAvisoDoEspelhoRecusado` junta decisão e gravação, e aqui se
 * afirma sobre o que chega ao banco — o SQL com a guarda e os parâmetros dela.
 */
describe("abrir o aviso na Central", () => {
  function bancoQueRegistra() {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows: [] };
      },
    };
    return { db: db as never, chamadas };
  }

  it("a perda sem motivo grava UM aviso, com a guarda por kind + ref + título ligada", async () => {
    const { db, chamadas } = bancoQueRegistra();

    await abreAvisoDoEspelhoRecusado(db, "org-1", {
      leadId: "lead-1",
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });

    expect(chamadas).toHaveLength(1);
    const { sql, params } = chamadas[0]!;
    expect(sql).toContain("where not exists");
    const titulo = avisoDoEspelhoRecusado({
      motivo: "perda_sem_motivo",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    })!.title;
    // Ordem dos parâmetros de `insertInboxItem`: org, kind, severity, title, body,
    // ref_kind, ref_id, "casa a ref?", "casa o título?".
    expect(params.slice(0, 2)).toEqual(["org-1", "other"]);
    expect(params[3]).toBe(titulo);
    expect(params.slice(5)).toEqual(["lead", "lead-1", true, true]);
  });

  it("warn-only não chega ao banco", async () => {
    const { db, chamadas } = bancoQueRegistra();

    await abreAvisoDoEspelhoRecusado(db, "org-1", {
      leadId: "lead-1",
      motivo: "human_conflict",
      detalhe: "d",
      etapaDeDestino: ETAPA,
    });

    expect(chamadas).toEqual([]);
  });

  it("o turno do agente abre o aviso por ESTA função, e não com um insert escrito à mão", () => {
    // O corpo do `update_lead_state` é inalcançável sem o runtime inteiro (LLM,
    // fila, pool). O que se prende aqui é a fiação: a chamada existe no ramo de
    // espelho recusado, e o insert manual — o que perdia o `dedupe` — não voltou.
    const fonte = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
      "utf8",
    );
    const i = fonte.indexOf("update_lead_state: tool({");
    const j = fonte.indexOf("// F3-11:", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const ramo = fonte.slice(i, j);
    expect(ramo).toMatch(/if \(!mirror\.ok\) \{[\s\S]*await abreAvisoDoEspelhoRecusado\(pool, tenantId, \{/);
    expect(ramo).not.toMatch(/insertInboxItem\(/);
  });
});
