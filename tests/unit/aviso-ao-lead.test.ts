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

describe("o texto respeita o estado REAL da equipe", () => {
  it("instalação sem ninguém configurado: registra, não promete prazo", () => {
    const t = textoDoAviso("pediu_humano", { disponiveis: 0, total: 0 }, LEAD);
    expect(t).toMatch(/registr|anotad|primeira oportunidade/i);
    expect(t).not.toMatch(/aguard/i);
  });

  it("leitura falhou é tratado como 'não sei' — mesma cautela", () => {
    const semLeitura = textoDoAviso("pediu_humano", null, LEAD);
    const semEquipe = textoDoAviso("pediu_humano", { disponiveis: 0, total: 0 }, LEAD);
    expect(semLeitura).toBe(semEquipe);
  });

  it("equipe existe mas ninguém livre: não convida a aguardar", () => {
    const t = textoDoAviso("pediu_humano", { disponiveis: 0, total: 3 }, LEAD);
    expect(t).toMatch(/ninguém|não há atendente/i);
    expect(t).not.toMatch(/aguarde só um momento|é só aguardar/i);
  });

  it("com gente livre: convida a aguardar na conversa", () => {
    const t = textoDoAviso("pediu_humano", { disponiveis: 2, total: 3 }, LEAD);
    expect(t).toMatch(/aguard|fica por aqui/i);
  });

  it("os três estados produzem fechos DIFERENTES", () => {
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

// Medido numa loja em espanhol (26/09/2026): a organização atende em espanhol e
// o cliente irritado recebeu "Esse caso é melhor resolvido por uma pessoa…" no
// meio do pedido. O aviso sai no idioma da ORGANIZAÇÃO.
describe("o aviso sai no idioma da organização", () => {
  const PALAVRAS_EM_PORTUGUES = /\b(você|seu|sua|equipe|atendente|não|já|ninguém|pedido ficou|aguarde|fica por aqui)\b/i;

  it("organização em espanhol: nenhuma palavra em português, em nenhum motivo nem estado", () => {
    for (const motivo of MOTIVOS) {
      for (const estado of ESTADOS) {
        for (let i = 0; i < 30; i++) {
          const t = textoDoAviso(motivo, estado.quem, randomUUID(), "es");
          expect(t, `${motivo} / ${estado.rotulo}`).not.toMatch(PALAVRAS_EM_PORTUGUES);
        }
      }
    }
  });

  it("o estado da equipe muda o fecho em espanhol como muda em português", () => {
    expect(textoDoAviso("outro", { disponiveis: 0, total: 0 }, LEAD, "es")).toMatch(/registrad|anotado|primera oportunidad/i);
    expect(textoDoAviso("outro", { disponiveis: 0, total: 3 }, LEAD, "es")).toMatch(/no hay/i);
    expect(textoDoAviso("outro", { disponiveis: 2, total: 3 }, LEAD, "es")).toMatch(/espera|quédate/i);
  });

  it("quem pediu para parar, em espanhol, não recebe convite para esperar", () => {
    for (const estado of ESTADOS) {
      const t = textoDoAviso("suspeita_de_opt_out", estado.quem, LEAD, "es");
      expect(t, estado.rotulo).toMatch(/dejo de|no se envían|detengo/i);
      expect(t, estado.rotulo).not.toMatch(/espera|cola/i);
    }
  });

  it("em espanhol também há ao menos 3 redações por motivo e estado", () => {
    for (const motivo of MOTIVOS) {
      for (const estado of ESTADOS) {
        const textos = new Set(
          Array.from({ length: 60 }, () => textoDoAviso(motivo, estado.quem, randomUUID(), "es")),
        );
        expect(textos.size, `${motivo} / ${estado.rotulo}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("o aviso em espanhol também não cabe na isenção do spinning (o desarme segue necessário)", () => {
    for (const m of MOTIVOS) {
      const t = normalizeCopy(textoDoAviso(m, null, LEAD, "es"));
      expect(t.length, m).toBeGreaterThan(SPINNING_DEFAULTS.allowlistMaxLength);
    }
  });

  it("locale espanhol com região vale; sem locale ou idioma sem frases segue em português", () => {
    const es = textoDoAviso("pediu_humano", null, LEAD, "es");
    expect(textoDoAviso("pediu_humano", null, LEAD, "es-MX")).toBe(es);
    const pt = textoDoAviso("pediu_humano", null, LEAD);
    expect(textoDoAviso("pediu_humano", null, LEAD, null)).toBe(pt);
    expect(textoDoAviso("pediu_humano", null, LEAD, "pt-BR")).toBe(pt);
    expect(pt).not.toBe(es);
  });
});
