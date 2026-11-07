/**
 * O lembrete de agendamento escolhe o canal do CONTATO (#2594).
 *
 * Antes, o cron pegava o primeiro canal `WORKING` da organização, sem ordem —
 * numa org com Instagram e WhatsApp, o lembrete saía por um canal imprevisível.
 * Agora: com telefone, canal de telefone (WhatsApp); sem telefone, canal social.
 *
 * O último caso importa tanto quanto os outros dois: sem a informação do
 * telefone, o comportamento antigo (ambíguo com mais de um elegível) tem de
 * continuar — não se inventa preferência com dado que não existe.
 */
import { describe, expect, it } from "vitest";

import {
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  transportaMensagem,
} from "@/lib/channels/capabilities";

import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";

import { decidirRemetenteDoLembrete, type CanalDoLembrete } from "./remetente-do-lembrete";

const agora = new Date("2026-10-29T12:00:00Z");
const ha10min = new Date("2026-10-29T11:50:00Z").toISOString();

/**
 * Os dois papéis do cenário vêm da MATRIZ de capacidades, não de um nome escrito
 * aqui. "Alcança o aparelho pelo telefone" é a diferença de natureza entre o
 * canal de telefone e o social, e o invariante 1 da doutrina de restrição de
 * canal proíbe uma feature — teste inclusive — nomear provider: escrever a
 * grafia neste arquivo seria a mesma fuga por outra porta, porque o lint cobra o
 * NOME e não a forma. A pergunta certa é à matriz: quem alcança um telefone?
 */
const PROVIDERS_QUE_ALCANCAM_O_APARELHO: readonly string[] = PROVIDERS_DE_TELEFONE;

/** O canal do destino por TELEFONE: o endereço do contato é um número. */
const PROVIDER_DE_APARELHO = PROVIDERS_DE_TELEFONE[0] as string;

/** O canal SOCIAL: entrega mensagem, mas o endereço de lá não é um telefone. */
const PROVIDER_SOCIAL = PROVIDERS_DE_MENSAGEM.find(
  (p) => !PROVIDERS_QUE_ALCANCAM_O_APARELHO.includes(p),
) as string;

function canal(id: string, provider: string): CanalDoLembrete {
  return {
    id,
    provider,
    status: "WORKING",
    archived_at: null,
    metadata: null,
    lastInboundAt: ha10min,
  };
}

const doTelefone = canal("c-telefone", PROVIDER_DE_APARELHO);
const social = canal("c-social", PROVIDER_SOCIAL);

describe("lembrete escolhe o canal do contato (#2594)", () => {
  it("a matriz oferece um canal de telefone e um social, os dois elegíveis (guarda do cenário)", () => {
    // Sem estes dois lados o cenário deixa de existir e os testes abaixo
    // passariam a não provar nada: o de cima precisa de um canal que alcance o
    // telefone, o de baixo de um que não alcance, e AMBOS têm de entregar
    // mensagem — senão o desempate seria por elegibilidade, não por telefone.
    expect(PROVIDERS_QUE_ALCANCAM_O_APARELHO).toContain(doTelefone.provider);
    expect(PROVIDERS_QUE_ALCANCAM_O_APARELHO).not.toContain(social.provider);
    expect(transportaMensagem(doTelefone.provider)).toBe(true);
    expect(transportaMensagem(social.provider)).toBe(true);
  });

  it("com telefone, escolhe o canal de telefone (WhatsApp) mesmo com social elegível", () => {
    const r = decidirRemetenteDoLembrete([social, doTelefone], null, agora, "5541999999999");
    expect(r.canal?.id).toBe("c-telefone");
    expect(r.motivo).toBeNull();
  });

  it("sem telefone, escolhe o canal social", () => {
    const r = decidirRemetenteDoLembrete([doTelefone, social], null, agora, null);
    expect(r.canal?.id).toBe("c-social");
  });

  it("sem a informação do telefone, mantém o comportamento anterior (ambíguo)", () => {
    const r = decidirRemetenteDoLembrete([doTelefone, social], null, agora);
    expect(r.canal).toBeNull();
    expect(r.motivo).toBe("remetente_ambiguo");
  });

  it("o vínculo indicado continua sendo autoridade sobre a preferência", () => {
    const r = decidirRemetenteDoLembrete([social, doTelefone], "c-social", agora, "5541999999999");
    expect(r.canal?.id).toBe("c-social");
  });

  it("a preferência só desempata ELEGÍVEIS: canal de telefone fora da janela não cala o social que pode", () => {
    // Regressão medida na triagem: o filtro por telefone vinha ANTES da
    // elegibilidade, e um canal de telefone de janela fechada (ou desligado)
    // esvaziava a lista — o lembrete que antes saía pelo social deixava de sair.
    const restrito = (PROVIDERS_DE_TELEFONE as readonly string[]).find(
      (p) => !canalAceitaTextoLivreAgora(p, null, agora),
    ) as string;
    expect(restrito).toBeTruthy();
    const fechado = { ...canal("c-telefone", restrito), lastInboundAt: null };
    const r = decidirRemetenteDoLembrete([fechado, social], null, agora, "5541999999999");
    expect(r.canal?.id).toBe("c-social");
  });

  it("canal de telefone desligado não cala o social elegível", () => {
    const desligado = { ...doTelefone, metadata: { disabled: true } };
    const r = decidirRemetenteDoLembrete([desligado, social], null, agora, "5541999999999");
    expect(r.canal?.id).toBe("c-social");
  });
});
