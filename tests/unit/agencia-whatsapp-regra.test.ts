import { describe, expect, it } from "vitest";

import type { CanalDoAviso, DecisaoDePacing } from "@/lib/escalacao/aviso-ao-suporte";
import {
  aplicaEnvioDaAgencia,
  dentroDaJanela,
  mascararTelefone,
  proximaAbertura,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  type ConfigDoWhatsapp,
  type DepsDoWhatsapp,
  type EnvioDaAgencia,
  type PatchDoEnvio,
} from "@/lib/agencia/whatsapp/regra";

/**
 * A entrega do WhatsApp da agência (docs/agencia/SPEC-whatsapp-agencia.md,
 * critérios 1, 3 e 4), com relógio, banco, transporte e pacing falsos.
 */

// 15h em São Paulo = 18h UTC.
const TARDE = new Date("2026-10-23T18:00:00Z");
// 23h em São Paulo = 02h UTC do dia seguinte.
const NOITE = new Date("2026-10-24T02:00:00Z");

const CANAL: CanalDoAviso = { id: "canal-1", status: "connected", archived_at: null, aceitaMensagemLivre: true };
const CONFIG: ConfigDoWhatsapp = { organizationId: "org-1", canalId: "canal-1", janelaInicio: "07:00:00", janelaFim: "22:00:00" };

function montar(opts: {
  agora?: Date;
  envio?: Partial<EnvioDaAgencia>;
  config?: ConfigDoWhatsapp | null;
  canal?: CanalDoAviso | null;
  configurado?: boolean;
  pacing?: DecisaoDePacing;
  destino?: string | null;
  envioFalha?: boolean;
}) {
  const agora = opts.agora ?? TARDE;
  const envio: EnvioDaAgencia = {
    id: "envio-1",
    motivo: "aviso",
    telefone: "+5511912345678",
    corpo: "Olá",
    situacao: "pendente",
    tentativas: 0,
    criado_em: new Date(agora.getTime() - 10 * 60_000).toISOString(),
    ...opts.envio,
  };
  const patches: PatchDoEnvio[] = [];
  const enviados: string[] = [];
  const registrados: Date[] = [];
  const deps: DepsDoWhatsapp = {
    clock: () => agora,
    db: {
      carregaEnvio: async () => envio,
      carregaConfig: async () => (opts.config === undefined ? CONFIG : opts.config),
      carregaCanal: async () => (opts.canal === undefined ? CANAL : opts.canal),
      atualizaEnvio: async (_id, p) => {
        patches.push(p);
      },
    },
    transporte: {
      configurado: async () => opts.configurado ?? true,
      resolveDestino: async () => (opts.destino === undefined ? "5511912345678@c.us" : opts.destino),
      envia: async (_org, _canal, to) => {
        if (opts.envioFalha) throw new Error("recusado");
        enviados.push(to);
        return { externalId: "ext-1" };
      },
    },
    pacing: {
      decide: async () => opts.pacing ?? { liberado: true },
      registraEnvio: async (_o, _c, quando) => {
        registrados.push(quando);
      },
    },
  };
  return { deps, patches, enviados, registrados };
}

describe("aplicaEnvioDaAgencia", () => {
  it("envia, registra no pacing e marca enviado", async () => {
    const m = montar({});
    const d = await aplicaEnvioDaAgencia(m.deps, "envio-1");
    expect(d.status).toBe("ok");
    expect(m.enviados).toEqual(["5511912345678@c.us"]);
    expect(m.registrados).toHaveLength(1);
    expect(m.patches.at(-1)).toMatchObject({ situacao: "enviado", external_id: "ext-1" });
  });

  it("sem configuração termina skipped, nunca error", async () => {
    const m = montar({ config: { ...CONFIG, canalId: null } });
    const d = await aplicaEnvioDaAgencia(m.deps, "envio-1");
    expect(d).toMatchObject({ status: "skipped", detail: "sem_configuracao" });
    expect(m.enviados).toEqual([]);
  });

  it("aviso fora da janela espera a abertura das 7h", async () => {
    const m = montar({ agora: NOITE });
    const d = await aplicaEnvioDaAgencia(m.deps, "envio-1");
    expect(d.status).toBe("retry");
    // 7h em São Paulo = 10h UTC.
    expect(d.retry_at).toBe("2026-10-24T10:00:00.000Z");
    expect(m.enviados).toEqual([]);
  });

  it("convite e teste não esperam a janela", async () => {
    for (const motivo of ["convite", "teste"] as const) {
      const m = montar({ agora: NOITE, envio: { motivo } });
      expect((await aplicaEnvioDaAgencia(m.deps, "envio-1")).status).toBe("ok");
    }
  });

  it("pacing segurando vira retry no horário que ele indicar", async () => {
    const liberaEm = new Date(TARDE.getTime() + 1_500);
    const m = montar({ pacing: { liberado: false, motivo: "espacamento", liberaEm } });
    const d = await aplicaEnvioDaAgencia(m.deps, "envio-1");
    expect(d).toMatchObject({ status: "retry", retry_at: liberaEm.toISOString() });
    expect(m.enviados).toEqual([]);
  });

  it("transporte recusando tenta de novo e depois desiste", async () => {
    const m = montar({ envioFalha: true });
    expect((await aplicaEnvioDaAgencia(m.deps, "envio-1")).status).toBe("retry");
    const ultimo = montar({ envioFalha: true, envio: { tentativas: TETO_DE_TENTATIVAS_DE_ENVIO - 1 } });
    const d = await aplicaEnvioDaAgencia(ultimo.deps, "envio-1");
    expect(d.status).toBe("skipped");
    expect(ultimo.patches.at(-1)).toMatchObject({ situacao: "falhou", erro_codigo: "envio_recusado" });
  });

  it("canal arquivado falha sem tentar", async () => {
    const m = montar({ canal: { ...CANAL, archived_at: "2026-10-01T00:00:00Z" } });
    expect((await aplicaEnvioDaAgencia(m.deps, "envio-1")).detail).toBe("canal_indisponivel");
    expect(m.enviados).toEqual([]);
  });

  it("envio com mais de 24 h é descartado", async () => {
    const m = montar({ envio: { criado_em: new Date(TARDE.getTime() - 25 * 3600_000).toISOString() } });
    expect((await aplicaEnvioDaAgencia(m.deps, "envio-1")).detail).toBe("envio_velho");
    expect(m.patches.at(-1)).toMatchObject({ situacao: "descartado" });
  });

  it("aviso recém-criado espera o agrupamento; convite não espera", async () => {
    const recente = new Date(TARDE.getTime() - 30_000).toISOString();
    const aviso = montar({ envio: { criado_em: recente } });
    const d = await aplicaEnvioDaAgencia(aviso.deps, "envio-1");
    expect(d).toMatchObject({ status: "retry", detail: "aguardando_agrupamento" });
    expect(aviso.enviados).toEqual([]);
    const convite = montar({ envio: { criado_em: recente, motivo: "convite" } });
    expect((await aplicaEnvioDaAgencia(convite.deps, "envio-1")).status).toBe("ok");
  });

  it("envio já resolvido não sai de novo", async () => {
    const m = montar({ envio: { situacao: "enviado" } });
    expect((await aplicaEnvioDaAgencia(m.deps, "envio-1")).status).toBe("skipped");
    expect(m.enviados).toEqual([]);
  });
});

describe("janela de horário", () => {
  it("15h está dentro de 7h–22h, 23h está fora", () => {
    expect(dentroDaJanela(TARDE, "07:00", "22:00")).toBe(true);
    expect(dentroDaJanela(NOITE, "07:00", "22:00")).toBe(false);
  });

  it("aceita janela que atravessa a meia-noite", () => {
    expect(dentroDaJanela(NOITE, "22:00", "06:00")).toBe(true);
  });

  it("a próxima abertura é sempre no futuro", () => {
    expect(proximaAbertura(TARDE, "07:00").getTime()).toBeGreaterThan(TARDE.getTime());
  });
});

describe("mascararTelefone", () => {
  it("guarda só os 4 últimos dígitos", () => {
    expect(mascararTelefone("+5511912345678")).toBe("••••5678");
  });
});
