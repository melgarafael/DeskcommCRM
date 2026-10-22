/**
 * O tour do fim do wizard não pode apontar para o vazio, nem ter texto próprio.
 *
 * As duas formas de apodrecer são conhecidas neste repositório: uma lista
 * paralela de telas que diverge do menu (foi o que a navegação agrupada veio
 * matar) e um card que sobrevive ao destino que ele anuncia.
 */
import { describe, expect, it } from "vitest";

import { oQueMaisExiste } from "@/lib/onboarding/o-que-mais-existe";
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

const PECAS = oQueMaisExiste();

describe("o que mais existe", () => {
  it("mostra um punhado, não as 34 telas", () => {
    // Despejar tudo trocaria "não sei o que existe" por "não sei por onde
    // começar".
    expect(PECAS.length).toBeGreaterThanOrEqual(4);
    expect(PECAS.length).toBeLessThanOrEqual(8);
  });

  it("todo destino existe no registro de navegação", () => {
    const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href as string));
    const orfaos = PECAS.filter((p) => !hrefs.has(p.href));
    expect(orfaos, "card apontando para uma tela que não existe mais").toEqual([]);
  });

  it("as descrições vêm do registro — nunca de uma segunda redação", () => {
    // Se alguém reescrever a frase aqui, ela passa a divergir do menu e da
    // busca na primeira edição de qualquer um dos dois.
    const porHref = new Map(NAV_DESTINATIONS.map((d) => [d.href as string, d]));
    for (const p of PECAS) {
      expect(p.descricao, p.href).toBe(porHref.get(p.href)?.description);
      expect(p.label, p.href).toBe(porHref.get(p.href)?.label);
    }
  });

  it("cada peça explica por que importa para quem acabou de montar o funcionário", () => {
    for (const p of PECAS) {
      expect(p.porQue.trim().length, p.href).toBeGreaterThan(30);
    }
  });

  it("apresenta a peça pelo que ela FAZ, não pelo nome técnico do menu", () => {
    // "Inbox", "Kanban", "Follow-ups", "Alertas" são os rótulos do menu — quem
    // instalou o sistema há dez minutos não reconhece nenhum deles.
    const tecnicos = /^(inbox|kanban|follow-?ups?|alertas|radar|propostas)$/i;
    const crus = PECAS.filter((p) => tecnicos.test(p.comoChamar.trim()));
    expect(crus.map((p) => p.comoChamar)).toEqual([]);
  });
});

describe("o tutorial de cada peça", () => {
  it("toda peça explica COMO funciona, em passos", () => {
    // Uma frase basta para dizer que a peça existe; não basta para as técnicas.
    for (const p of PECAS) {
      expect(p.comoFunciona.length, p.href).toBeGreaterThanOrEqual(3);
      expect(p.comoFunciona.length, p.href).toBeLessThanOrEqual(6);
    }
  });

  it("os passos são frases inteiras, não rótulos", () => {
    for (const p of PECAS) {
      for (const passo of p.comoFunciona) {
        expect(passo.trim().length, `${p.href}: ${passo}`).toBeGreaterThan(20);
      }
    }
  });

  it("o follow-up diz que o retorno PARA quando o cliente responde", () => {
    // É a peça que mais assusta pelo nome. Quem imagina um robô perseguindo
    // cliente desliga justamente o que mais recupera venda — e o comportamento
    // real é o contrário: `lib/followup/reactivity.ts` reage a mensagem
    // recebida, a pedido de parar e a atendimento humano.
    const followup = PECAS.find((p) => p.href === "/app/automacoes/fluxos");
    expect(followup, "o tour precisa apresentar o follow-up").toBeTruthy();
    const texto = followup!.comoFunciona.join(" ").toLowerCase();
    expect(texto).toMatch(/responder?, o retorno para|para na hora/);
    expect(texto).toMatch(/pedir para parar|parar/);
  });

  it("nenhum passo usa nome técnico", () => {
    const tecnicos = /\b(enrollment|webhook|endpoint|trigger|payload|jsonb|prompt|token)\b/i;
    const sujos = PECAS.flatMap((p) => p.comoFunciona.filter((x) => tecnicos.test(x)));
    expect(sujos).toEqual([]);
  });
});
