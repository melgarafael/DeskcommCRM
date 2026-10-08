import { describe, expect, it } from "vitest";

import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";
import { BEFORE_SEND_GATES } from "@/lib/agent-engine/guardrails/before-send";

/**
 * A checagem textual suplementar não substitui os gates do motor de prévia,
 * nem comprova autorização ou segurança de um envio real.
 */
describe("avaliação da resposta no botão Testar", () => {
  it("pega o vazamento REAL medido em produção", () => {
    // O texto é o que um modelo de verdade respondeu (RELATORIO da medição,
    // cenário 7): código de erro cru copiado do resultado da ferramenta.
    const r = avaliarRespostaDeTeste(
      "As execuções mais recentes deram erro na ação de webhook: unsafe_url:https_required",
    );
    expect(r.passou).toBe(false);
    expect(r.termos.length).toBeGreaterThan(0);
  });

  it("aprova a resposta traduzida — a que o gate produziu depois do veto", () => {
    // Também medida: é o que o cliente recebeu depois de o modelo reescrever.
    // Se isto reprovasse, o teste viraria ruído e o time desligaria a checagem.
    const r = avaliarRespostaDeTeste(
      "Verifiquei as regras automáticas. A integração foi bloqueada porque o endereço " +
        "configurado não atende ao requisito de conexão segura. Posso encaminhar para a equipe.",
    );
    expect(r.passou).toBe(true);
    expect(r.termos).toEqual([]);
  });

  it("resposta ausente NÃO é aprovada por omissão", () => {
    // "Sem texto, logo passou" seria o mesmo silêncio-que-parece-aprovação que
    // este módulo existe para corrigir.
    expect(avaliarRespostaDeTeste(undefined).naoAvaliados.length).toBeGreaterThan(0);
  });

  it("texto vazio (teste bloqueado) não sai como `passou: true`", () => {
    // Sem resposta não existe veredito de conteúdo para mostrar como aprovado.
    for (const vazio of [undefined, "", "   \n"]) {
      const r = avaliarRespostaDeTeste(vazio);
      expect(r.passou, JSON.stringify(vazio)).toBe(false);
      expect(r.avaliado, JSON.stringify(vazio)).toBe(false);
      // Não há termo achado: a tela não pode dizer "usa palavras internas".
      expect(r.termos).toEqual([]);
    }
    expect(avaliarRespostaDeTeste("olá, tudo bem?").avaliado).toBe(true);
  });

  it("declara o que NÃO avaliou — a lista é o conserto, não um detalhe", () => {
    const r = avaliarRespostaDeTeste("olá, tudo bem?");
    expect(r.passou).toBe(true);
    // Passar sem dizer o que ficou de fora é a mentira mais bonita: tem
    // aparência de prova e não é.
    expect(r.naoAvaliados.length).toBeGreaterThan(0);
    for (const n of r.naoAvaliados) {
      expect(n.porque, `${n.gate} sem motivo legível`).not.toBe("");
    }
  });

  it("não promete ausência de custo nem confunde checagem textual com prévia do motor", () => {
    const r = avaliarRespostaDeTeste("olá");
    const semantico = r.naoAvaliados.find((n) => n.gate === "semantic_promise");
    expect(semantico?.porque).toContain("checagem textual");
    expect(semantico?.porque).not.toMatch(/não gasta|sem (?:chamada|custo)/i);
    expect(semantico?.porque).toMatch(/modelo|prévia/i);
  });

  it("o motivo de cada não-avaliado é escrito para o DONO DO NEGÓCIO", () => {
    // A lista aparece na tela de quem configura. "depende do send_ledger" não
    // informa nada a um dono de clínica — e repetiria, na tela de configuração,
    // o mesmo defeito de vocabulário que a spec 16 existe para matar.
    const texto = avaliarRespostaDeTeste("oi")
      .naoAvaliados.map((n) => n.porque)
      .join(" ")
      .toLowerCase();
    for (const jargao of ["ledger", "send_", "gate", "trace", "payload", "jsonb"]) {
      expect(texto, `jargão no motivo mostrado ao usuário: ${jargao}`).not.toContain(jargao);
    }
  });

  it("a lista de não-avaliados cobre os gates da cadeia REAL — não uma lista inventada", () => {
    // Amarra a declaração à cadeia de verdade: se alguém acrescentar um gate a
    // `BEFORE_SEND_GATES`, este teste vermelha e força a decisão de que lado ele
    // cai — avaliável no teste, ou declarado como não-avaliável.
    const declarados = new Set(avaliarRespostaDeTeste("oi").naoAvaliados.map((n) => n.gate));
    // `internal_vocabulary` é o único que o teste consegue avaliar; todos os
    // outros da cadeia têm de estar declarados.
    const esperados = BEFORE_SEND_GATES.map((g) => g.name).filter((n) => n !== "internal_vocabulary");
    expect([...declarados].sort()).toEqual([...esperados].sort());
  });
});

describe("avaliação da resposta no botão Testar — mídia do produto (#2490)", () => {
  const limpo = "Segue a foto do produto que você pediu.";
  const preparada = {
    codigo: "IP15",
    produtoResolvido: true,
    fotosCadastradas: 1,
    fotosPreparadas: 1,
    anexos: [{ storagePath: "org/dry-run/catalogo-a.jpg", mime: "image/jpeg" }],
  };

  it("texto limpo com a foto PENDENTE não é aprovado", () => {
    // Sem esta guarda, o candidato de um send_message sem produto_codigo, vindo
    // depois do que falhou a foto, faria a tela aprovar o teste com a mídia pendente.
    const r = avaliarRespostaDeTeste(limpo, [
      { ...preparada, fotosPreparadas: 0, anexos: [], falha: { code: "midia_nao_preparada", message: "x" } },
    ]);
    expect(r.passou).toBe(false);
    expect(r.midia).toHaveLength(1);
  });

  it("texto limpo com a foto preparada passa — a guarda não reprova tudo", () => {
    expect(avaliarRespostaDeTeste(limpo, [preparada]).passou).toBe(true);
  });
});
