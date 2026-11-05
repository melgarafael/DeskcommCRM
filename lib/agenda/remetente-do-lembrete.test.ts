import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_PROVIDER,
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_SOCIAL,
  CHANNEL_PROVIDER_WACALLS,
} from "@/lib/channels/capabilities";
import { decidirRemetenteDoLembrete, type CanalDoLembrete } from "./remetente-do-lembrete";

const agora = new Date("2026-10-09T15:00:00Z");
const canal = (id: string, patch: Partial<CanalDoLembrete> = {}): CanalDoLembrete => ({
  id,
  provider: DEFAULT_CHANNEL_PROVIDER,
  status: "WORKING",
  archived_at: null,
  lastInboundAt: null,
  ...patch,
});
const clinica = canal("clinica");
const cursos = canal("cursos");
describe("remetente da reserva, sem depender da ordem do banco", () => {
  it.each([
    [clinica, cursos],
    [cursos, clinica],
  ])("canal indicado ganha com lista %j", (...canais) => {
    expect(decidirRemetenteDoLembrete(canais, "clinica", agora).canal?.id).toBe("clinica");
  });
  it("dois canais sem vínculo impedem envio", () => {
    expect(decidirRemetenteDoLembrete([cursos, clinica], null, agora)).toEqual({
      canal: null,
      motivo: "remetente_ambiguo",
    });
  });
  it.each([
    { status: "STOPPED" },
    { archived_at: "2026-10-01T00:00:00Z" },
    { metadata: { disabled: true } },
    { provider: CHANNEL_PROVIDER_WACALLS },
    { provider: "desconhecido" },
  ])("canal indicado indisponível %j nunca troca pelo outro", (patch) => {
    expect(decidirRemetenteDoLembrete([canal("clinica", patch), cursos], "clinica", agora)).toEqual(
      { canal: null, motivo: "canal_indicado_indisponivel" },
    );
  });
  it("canal indicado desaparecido nunca troca", () => {
    expect(decidirRemetenteDoLembrete([cursos], "clinica", agora).motivo).toBe(
      "canal_indicado_indisponivel",
    );
  });
  it("único automático elegível preserva organizações com um número", () => {
    expect(
      decidirRemetenteDoLembrete(
        [clinica, canal("voz", { provider: CHANNEL_PROVIDER_WACALLS })],
        null,
        agora,
      ).canal?.id,
    ).toBe("clinica");
  });
  it("janela fechada no indicado não autoriza canal de outro setor", () => {
    const fechado = canal("clinica", { provider: CHANNEL_PROVIDER_META });
    expect(decidirRemetenteDoLembrete([fechado, cursos], "clinica", agora).motivo).toBe(
      "canal_fora_da_janela_24h",
    );
    expect(decidirRemetenteDoLembrete([fechado, cursos], null, agora).canal?.id).toBe("cursos");
  });
  it("janela aberta e limite de 24h usam a régua nativa", () => {
    const aberto = canal("clinica", {
      provider: CHANNEL_PROVIDER_META,
      lastInboundAt: "2026-10-08T15:00:01Z",
    });
    expect(decidirRemetenteDoLembrete([aberto], "clinica", agora).canal?.id).toBe("clinica");
    expect(
      decidirRemetenteDoLembrete(
        [{ ...aberto, lastInboundAt: "2026-10-08T15:00:00Z" }],
        "clinica",
        agora,
      ).motivo,
    ).toBe("canal_fora_da_janela_24h");
  });
  it("fora da janela, com UM número certo, diz qual é — para o modelo aprovado", () => {
    // O campo não autoriza texto livre: `canal` segue nulo. Ele só diz por qual
    // número um modelo aprovado do tipo ainda pode sair.
    const fechado = canal("clinica", { provider: CHANNEL_PROVIDER_META });
    const fora = (r: ReturnType<typeof decidirRemetenteDoLembrete>) => (r.canal ? undefined : r.foraDaJanela);
    expect(decidirRemetenteDoLembrete([fechado], "clinica", agora).canal).toBeNull();
    expect(fora(decidirRemetenteDoLembrete([fechado], "clinica", agora))?.id).toBe("clinica");
    expect(fora(decidirRemetenteDoLembrete([fechado], null, agora))?.id).toBe("clinica");
    const outro = canal("cursos", { provider: CHANNEL_PROVIDER_META });
    // Dois números fora da janela: nenhum é "o" remetente.
    expect(fora(decidirRemetenteDoLembrete([fechado, outro], null, agora))).toBeUndefined();
    // Indicado indisponível nunca vira candidato.
    expect(fora(decidirRemetenteDoLembrete([canal("clinica", { provider: CHANNEL_PROVIDER_META, status: "STOPPED" })], "clinica", agora))).toBeUndefined();
  });
  it("fora da janela, a preferência pelo canal do contato (#2594) também escolhe o número do modelo", () => {
    const oficial = canal("oficial", { provider: CHANNEL_PROVIDER_META });
    const social = canal("social", { provider: CHANNEL_PROVIDER_SOCIAL });
    const fora = (r: ReturnType<typeof decidirRemetenteDoLembrete>) => (r.canal ? undefined : r.foraDaJanela);
    // Com telefone, o de telefone; sem telefone informado, nenhuma preferência — e dois é ambíguo.
    expect(fora(decidirRemetenteDoLembrete([social, oficial], null, agora, "+5511900000000"))?.id).toBe("oficial");
    expect(fora(decidirRemetenteDoLembrete([social, oficial], null, agora))).toBeUndefined();
  });
  it("zero canais falha de maneira explícita", () => {
    expect(decidirRemetenteDoLembrete([], null, agora).motivo).toBe("sem_canal");
  });
});
