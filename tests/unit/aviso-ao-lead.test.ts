/**
 * A FRASE QUE O CLIENTE LÊ QUANDO A IA SAI DE CAMPO — e a conta que a mantém viva.
 *
 * O defeito que este arquivo prende foi MEDIDO em produção, não deduzido
 * (2026-08-26, duas conversas na mesma hora): as duas passagens para humano do
 * repo silenciavam o automático sem dizer nada a quem estava do outro lado. Numa
 * delas o agente tinha acabado de PERGUNTAR o e-mail do cliente; ele respondeu
 * para o vazio.
 *
 * Há três coisas a prender aqui, e só a primeira é óbvia:
 *
 *   1. o texto certo para cada motivo e cada estado da equipe;
 *   2. que quem pediu para PARAR não recebe oferta de atendente;
 *   3. **a conta do spinning** — a que reprovou a primeira versão do conserto.
 *      `decideSpinning` veta a candidata quando ela é idêntica ou quase (Jaccard
 *      ≥ 0,8) a 2+ das últimas 20 mensagens DAQUELE NÚMERO, janela que cruza
 *      leads. Com texto fixo, o terceiro cliente a pedir um atendente na mesma
 *      janela receberia silêncio — pelo guardrail. O caso `pior caso real`
 *      abaixo mede isso com a função REAL do gate, e é ele que justifica o
 *      `enforceSpinning: false` em `aviso-de-escalacao.ts`.
 */
import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  motivoDoAviso,
  textoDoAviso,
  type MotivoDoAviso,
} from "@/lib/escalacao/aviso-ao-lead";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import {
  decideSpinning,
  hashNormalized,
  normalizeCopy,
} from "@/lib/agent-engine/spinning/engine";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/** Lead fixo — o sorteio de variante é por hash, então o texto é reprodutível. */
const LEAD = "11111111-1111-4111-8111-111111111111";

const MOTIVOS: MotivoDoAviso[] = [
  "pediu_humano",
  "suspeita_de_opt_out",
  "orcamento_de_ia",
  "outro",
];
const ESTADOS: Array<{ rotulo: string; quem: QuemPodeAssumir | null }> = [
  { rotulo: "leitura falhou", quem: null },
  { rotulo: "instalação fresca", quem: { disponiveis: 0, total: 0 } },
  { rotulo: "fora de expediente", quem: { disponiveis: 0, total: 3 } },
  { rotulo: "com gente livre", quem: { disponiveis: 2, total: 3 } },
];

describe("motivoDoAviso traduz o que o banco grava", () => {
  it("mapeia os motivos que mudam a frase", () => {
    expect(motivoDoAviso("requested_human")).toBe("pediu_humano");
    expect(motivoDoAviso("suspected_optout")).toBe("suspeita_de_opt_out");
    expect(motivoDoAviso("orcamento_de_ia")).toBe("orcamento_de_ia");
  });

  it("vocabulário ABERTO cai em 'outro', nunca em erro", () => {
    // `last_handoff_reason` recebe texto livre do atendente ao escalar um caso.
    // Um mapa exaustivo obrigaria este módulo a conhecer cada motivo novo para
    // não quebrar — e o desfecho de "não conheço" tem de ser a frase honesta.
    expect(motivoDoAviso("low_sentiment")).toBe("outro");
    expect(motivoDoAviso("legal_mention")).toBe("outro");
    expect(motivoDoAviso("preciso que o financeiro veja isso")).toBe("outro");
    expect(motivoDoAviso("")).toBe("outro");
  });
});

describe("o aviso NÃO revela o estado da equipe (regra do dono)", () => {
  it("nenhum motivo/estado fala em fila, indisponibilidade, espera ou prazo", () => {
    for (const motivo of MOTIVOS) {
      for (const estado of ESTADOS) {
        const t = textoDoAviso(motivo, estado.quem, LEAD);
        expect(t, `${motivo} / ${estado.rotulo}`).not.toMatch(
          /fila|indispon|ninguém|equipe responde|aguard|instante|expediente|prazo/i,
        );
      }
    }
  });

  it("diz que passa o atendimento ao responsável e que ele entra em contato por aqui", () => {
    const t = textoDoAviso("pediu_humano", { disponiveis: 0, total: 3 }, LEAD);
    expect(t).toMatch(/respons[áa]vel/i);
    expect(t).toMatch(/entra(r)? em contato|te chama|te responde|fala com voc/i);
    expect(t).toMatch(/por aqui/i);
  });

  it("leitura falhou é tratado como 'não sei' — mesma frase", () => {
    const semLeitura = textoDoAviso("pediu_humano", null, LEAD);
    const semEquipe = textoDoAviso("pediu_humano", { disponiveis: 0, total: 0 }, LEAD);
    expect(semLeitura).toBe(semEquipe);
  });

  it("os três estados variam a redação (gate anti-spinning)", () => {
    // Sem este caso, três ramos colapsados num texto só passariam calados.
    const fechos = new Set(
      ESTADOS.filter((e) => e.rotulo !== "leitura falhou").map((e) =>
        textoDoAviso("pediu_humano", e.quem, LEAD),
      ),
    );
    expect(fechos.size).toBe(3);
  });
});

describe("quem pediu para PARAR não recebe oferta de atendimento", () => {
  it("confirma a parada e não fala em atendente, fila nem espera", () => {
    for (const estado of ESTADOS) {
      const t = textoDoAviso("suspeita_de_opt_out", estado.quem, LEAD);
      expect(t, estado.rotulo).toMatch(/parar|encerro|não mando/i);
      expect(t, estado.rotulo).not.toMatch(/atendente/i);
      expect(t, estado.rotulo).not.toMatch(/aguard|fila/i);
    }
  });

  it("o estado da equipe NÃO muda a frase de opt-out", () => {
    // Ela responde ao pedido da pessoa, não ao expediente do time. Se um fecho
    // de disponibilidade vazasse para cá, o texto viraria "não te mando mais
    // nada… aguarde um instante", que é contraditório.
    const textos = new Set(ESTADOS.map((e) => textoDoAviso("suspeita_de_opt_out", e.quem, LEAD)));
    expect(textos.size).toBe(1);
  });
});

describe("o aviso é determinístico por lead e variado entre leads", () => {
  it("mesmo lead, mesma frase — sempre", () => {
    const a = textoDoAviso("pediu_humano", { disponiveis: 1, total: 1 }, LEAD);
    const b = textoDoAviso("pediu_humano", { disponiveis: 1, total: 1 }, LEAD);
    expect(a).toBe(b);
  });

  /**
   * ⚠️ A primeira versão deste caso pedia `> 1` texto distinto só em
   * `pediu_humano` com equipe livre — e passava VERDE com as variantes de
   * abertura apagadas, porque o FECHO variava sozinho. Sabotagem medida: removi
   * as três aberturas e o arquivo seguiu 14/14.
   *
   * A propriedade que importa não é "o array tem N itens", é **o número não
   * repete UMA frase para todo mundo** — e ela vale para TODO par
   * (motivo, estado), inclusive o de opt-out, cujo fecho é fixo por desenho e
   * portanto só varia se a abertura variar. É este `every` que fecha o buraco.
   */
  it("todo motivo, em todo estado, produz ao menos 3 redações entre leads", () => {
    for (const motivo of MOTIVOS) {
      for (const estado of ESTADOS) {
        const textos = new Set(
          Array.from({ length: 60 }, () => textoDoAviso(motivo, estado.quem, randomUUID())),
        );
        expect(textos.size, `${motivo} / ${estado.rotulo}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("nada do id do lead aparece no texto", () => {
    const id = "abc12345-dead-4beef-8888-000000000001";
    const t = textoDoAviso("outro", null, id);
    expect(t).not.toContain(id);
    expect(t).not.toContain(createHash("sha256").update(id).digest("hex").slice(0, 8));
  });
});

describe("a conta do spinning — por que o gate é desarmado para o aviso", () => {
  /**
   * Simula N escalações seguidas no MESMO número, leads diferentes, e conta
   * quantos avisos o `spinningGate` vetaria se estivesse armado. É a função
   * real do gate, com os knobs default de produção.
   */
  function vetadosComOGateArmado(motivo: MotivoDoAviso, quem: QuemPodeAssumir | null, n: number) {
    const janela: Array<{ normalizedText: string; normalizedHash: string }> = [];
    let vetados = 0;
    for (let i = 0; i < n; i++) {
      const body = textoDoAviso(motivo, quem, `lead-${i}-${LEAD}`);
      if (!decideSpinning({ candidate: body, window: janela, knobs: SPINNING_DEFAULTS }).allow) {
        vetados += 1;
      }
      const norm = normalizeCopy(body);
      janela.unshift({ normalizedText: norm, normalizedHash: hashNormalized(norm) });
    }
    return vetados;
  }

  it("o aviso NÃO é curto o bastante para a isenção automática do gate", () => {
    // `isAllowlisted` isenta corpo com até `allowlistMaxLength` caracteres. Se o
    // aviso coubesse ali, o desarme explícito seria supérfluo — e alguém o
    // removeria. Ele não cabe, e é esta linha que prova.
    for (const m of MOTIVOS) {
      const t = normalizeCopy(textoDoAviso(m, null, LEAD));
      expect(t.length, m).toBeGreaterThan(SPINNING_DEFAULTS.allowlistMaxLength);
    }
  });

  it("com o gate ARMADO, a maioria dos avisos seguidos morreria calada", () => {
    // ISTO é o motivo de `enforceSpinning: false`. Não é hipótese: a primeira
    // versão do conserto tinha só as variantes, e esta conta a reprovou.
    // Se um dia a contagem cair a zero (mais variantes, outros knobs), o
    // desarme pode ser reavaliado — e este teste vermelhecendo é o convite.
    for (const m of MOTIVOS) {
      expect(vetadosComOGateArmado(m, null, 20), m).toBeGreaterThan(5);
    }
  });
});
