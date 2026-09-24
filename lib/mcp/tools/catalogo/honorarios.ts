/**
 * Capacidades de HONORÁRIOS — módulo opcional de advocacia (ADR-0002).
 *
 * `modulo: "honorarios"`: com o módulo desligado (não instalado em `/admin/modulos`), estas
 * duas entradas somem da tela de capacidades, do agente publicado e do cliente MCP externo —
 * ninguém liga o que não existe. Ver `deModuloDesligado` em `./index.ts`.
 */
import { declararTools } from "./tipos";

export const TOOLS_HONORARIOS = declararTools([
  {
    name: "crm_get_honorarios_contrato",
    category: "read",
    rotulo: "Ver o contrato de honorários do caso",
    explicacao:
      "Mostra o modelo de cobrança do caso (fixo, êxito ou misto) e o valor ou percentual combinado, para o assistente responder sobre honorários sem inventar um número.",
    oQueToca: "Contrato de honorários",
    risco: "seguro",
    // Só `atender`, nunca `vender` (o pacote padrão do onboarding — CLAUDE.md /
    // `pacote-reserva-vaga-da-critica.test.ts`): `vender` já consome a folga do
    // teto de 25 quase inteira, e qualquer capacidade nova ligada por ELE
    // reduz a vaga de TODO outro pacote no agente recém-nascido. `atender` cabe
    // — é onde a pergunta "quanto eu devo?" de um cliente já atendido pertence.
    pacotes: ["atender"],
    modulo: "honorarios",
  },
  {
    name: "crm_list_honorarios_parcelas",
    category: "read",
    rotulo: "Ver as parcelas de honorários",
    explicacao:
      "Mostra as parcelas de um contrato de honorários com vencimento, valor e se já foi paga, para o assistente confirmar cobrança em vez de estimar.",
    oQueToca: "Parcelas de honorários",
    risco: "seguro",
    pacotes: ["atender"],
    modulo: "honorarios",
  },
]);
