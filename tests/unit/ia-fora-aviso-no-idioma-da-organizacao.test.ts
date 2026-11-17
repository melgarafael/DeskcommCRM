/**
 * O aviso "a IA inteira está fora" (#4610) sai no idioma da ORGANIZAÇÃO, como os
 * demais avisos deste arquivo desde o #4724: a Central mostra o texto como foi
 * gravado. Em pt-BR ele é o texto de antes, byte a byte; em es nenhuma frase fixa
 * fica em português; e o fechamento por chamada reconhece o título gravado em
 * qualquer um dos dois.
 */
import { describe, expect, it } from "vitest";

import {
  avaliarAvisoDaAssinatura,
  CORPO_DA_RESOLUCAO_PELA_CHAMADA,
  TITULO_DA_IA_FORA,
} from "@/lib/ai/credenciais/assinatura-desconectada";

const iaFora = {
  assinatura: { provider: "openai", http_status: 401, error_code: "token_revogado", error_message: "x" },
  reserva: { provider: "anthropic", http_status: null, error_code: "sem_saldo", error_message: "y" },
};

describe("o aviso de IA fora no idioma da organização", () => {
  it("pt-BR: o título é a constante e o corpo diz as duas credenciais", () => {
    const d = avaliarAvisoDaAssinatura({ conectada: false, recusa: null, iaFora }, null);
    expect(d.acao).toBe("abrir");
    if (d.acao !== "abrir") return;
    expect(d.titulo).toBe(TITULO_DA_IA_FORA);
    expect(d.corpo).toContain("As duas credenciais de IA desta empresa recusaram a chamada:");
    expect(d.corpo).toContain("• assinatura: openai — token_revogado (HTTP 401): x");
    expect(d.corpo).toContain("• reserva: anthropic — sem_saldo (HTTP sem status): y");
  });

  it("es: título e corpo traduzidos, sem frase fixa em português", () => {
    const d = avaliarAvisoDaAssinatura({ conectada: false, recusa: null, iaFora }, null, "es");
    expect(d.acao).toBe("abrir");
    if (d.acao !== "abrir") return;
    expect(d.titulo).toBe("La IA dejó de responder — la suscripción y la reserva fallaron");
    expect(d.corpo).toContain("Las dos credenciales de IA de esta empresa rechazaron la llamada:");
    expect(d.corpo).toContain("• suscripción: openai — token_revogado (HTTP 401): x");
    expect(d.corpo).toContain("(HTTP sin estado)");
    for (const pt of ["As duas credenciais", "• assinatura:", "Sem nenhum provedor", "Para voltar:", "sem status"])
      expect(d.corpo, `ficou em português: ${pt}`).not.toContain(pt);
  });

  it("a volta por chamada fecha o item gravado com o título traduzido, e só ele", () => {
    const traduzido = { id: "1", body: "", title: "La IA dejó de responder — la suscripción y la reserva fallaron" };
    const fechou = avaliarAvisoDaAssinatura({ conectada: true, recusa: null, voltaPorChamada: true }, traduzido, "es");
    expect(fechou.acao).toBe("resolver");
    if (fechou.acao === "resolver") expect(fechou.corpo).not.toContain(CORPO_DA_RESOLUCAO_PELA_CHAMADA);

    const deLogin = { id: "2", body: "", title: "La cuenta de ChatGPT se desconectó — la IA dejó de responder" };
    expect(avaliarAvisoDaAssinatura({ conectada: true, recusa: null, voltaPorChamada: true }, deLogin, "es").acao).toBe(
      "nada",
    );
  });
});
