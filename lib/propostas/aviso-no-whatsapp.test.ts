// lib/propostas/aviso-no-whatsapp.test.ts
import { describe, expect, it, vi } from "vitest";

import { aplicaAvisoDeProposta, montarAvisoDeProposta, type AvisoDePropostaDeps } from "./aviso-no-whatsapp";

const AGORA = new Date("2026-09-26T12:00:00.000Z");

function evento(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    organization_id: "org-1",
    event_type: "proposal.ready_for_review",
    entity_kind: "proposal",
    entity_id: "prop-1",
    payload: { proposal_id: "prop-1", lead_id: "lead-1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: "2026-09-26T11:59:00.000Z",
    ...over,
  } as never;
}

function deps(over: Partial<{
  preferencia: boolean;
  config: unknown;
  proposta: unknown;
  avisoAberto: boolean;
  canal: unknown;
  urlPublica: string;
  origem: "worker" | "request";
  pacing: unknown;
  enviaFalha: boolean;
}> = {}) {
  const envia = vi.fn(async () => {
    if (over.enviaFalha) throw new Error("recusado");
    return { externalId: "ext-1" };
  });
  const audita = vi.fn();
  const registraEnvio = vi.fn(async () => undefined);
  const d: AvisoDePropostaDeps = {
    db: {
      preferencia: async () => over.preferencia ?? true,
      carregaConfig: async () =>
        (over.config === undefined
          ? { organization_id: "org-1", channel_session_id: "canal-1", telefone_destino: "+5511999990000", destino_jid: null, ligado: true }
          : over.config) as never,
      carregaProposta: async () =>
        (over.proposta === undefined ? { titulo: "Site catálogo", status: "rascunho", contact_id: "c-1" } : over.proposta) as never,
      avisoAberto: async () => over.avisoAberto ?? true,
      nomeDoContato: async () => "Maria Silva",
      carregaCanal: async () =>
        (over.canal === undefined ? { id: "canal-1", status: "WORKING", archived_at: null, aceitaMensagemLivre: true } : over.canal) as never,
      registraJidDoAviso: async () => undefined,
      marcaDaOrganizacao: async () => ({ nome: "Acme", idioma: "pt-BR" as const }),
    },
    transporte: {
      configurado: async () => true,
      resolveDestino: async () => "5511999990000@c.us",
      envia,
    },
    pacing: {
      decide: async () => (over.pacing ?? { liberado: true }) as never,
      registraEnvio,
    },
    clock: () => AGORA,
    urlPublica: over.urlPublica ?? "https://crm.exemplo.com.br",
    origemDoDreno: () => over.origem ?? "worker",
    audita,
  };
  return { d, envia, audita, registraEnvio };
}

describe("montarAvisoDeProposta", () => {
  it("marca, título, primeiro nome e link", () => {
    const texto = montarAvisoDeProposta({ marca: "Acme", idioma: "pt-BR", titulo: "Site catálogo", cliente: "Maria Silva", link: "https://x/app/proposals/p" });
    expect(texto).toContain("Acme");
    expect(texto).toContain("Site catálogo");
    expect(texto).toContain("Maria");
    expect(texto).not.toContain("Silva");
    expect(texto).toContain("https://x/app/proposals/p");
  });
});

describe("aplicaAvisoDeProposta", () => {
  it("caminho feliz: envia ao número da equipe, conta no pacing e audita com destino mascarado", async () => {
    const { d, envia, audita, registraEnvio } = deps();
    const r = await aplicaAvisoDeProposta(d, evento());
    expect(r.status).toBe("ok");
    expect(envia).toHaveBeenCalledWith("org-1", expect.anything(), "5511999990000@c.us", expect.stringContaining("/app/proposals/prop-1"));
    expect(registraEnvio).toHaveBeenCalled();
    expect(audita).toHaveBeenCalledWith(
      expect.objectContaining({ action: "proposal.aviso_whatsapp_enviado", metadata: expect.objectContaining({ destino_mascarado: "••••0000" }) }),
    );
  });

  it("organização sem Aviso no WhatsApp configurado: pula sem rede", async () => {
    const { d, envia } = deps({ config: null });
    expect(await aplicaAvisoDeProposta(d, evento())).toMatchObject({ status: "skipped", detail: "sem_configuracao" });
    expect(envia).not.toHaveBeenCalled();
  });

  it("aviso configurado mas desligado: pula", async () => {
    const { d } = deps({ config: { organization_id: "org-1", channel_session_id: "canal-1", telefone_destino: "+55", destino_jid: null, ligado: false } });
    expect((await aplicaAvisoDeProposta(d, evento())).detail).toBe("sem_configuracao");
  });

  it("chave desligada em Configurações › Propostas: pula", async () => {
    const { d, envia } = deps({ preferencia: false });
    expect((await aplicaAvisoDeProposta(d, evento())).detail).toBe("desligado_em_propostas");
    expect(envia).not.toHaveBeenCalled();
  });

  it("proposta que saiu de rascunho: não envia", async () => {
    const { d, envia } = deps({ proposta: { titulo: "x", status: "enviada", contact_id: null } });
    expect((await aplicaAvisoDeProposta(d, evento())).detail).toBe("proposta_fora_de_rascunho");
    expect(envia).not.toHaveBeenCalled();
  });

  it("aviso da Central já resolvido: não envia", async () => {
    const { d, envia } = deps({ avisoAberto: false });
    expect((await aplicaAvisoDeProposta(d, evento())).detail).toBe("aviso_ja_resolvido");
    expect(envia).not.toHaveBeenCalled();
  });

  it("evento com mais de 30 minutos: não envia", async () => {
    const { d, envia } = deps();
    const r = await aplicaAvisoDeProposta(d, evento({ created_at: "2026-09-26T11:00:00.000Z" }));
    expect(r.detail).toBe("evento_velho");
    expect(envia).not.toHaveBeenCalled();
  });

  it("dreno dentro de requisição: adia sem tocar a rede", async () => {
    const { d, envia } = deps({ origem: "request" });
    expect((await aplicaAvisoDeProposta(d, evento())).status).toBe("retry");
    expect(envia).not.toHaveBeenCalled();
  });

  it("canal desconectado: tenta de novo; na 6ª tentativa desiste e audita a falha", async () => {
    const canal = { id: "canal-1", status: "STOPPED", archived_at: null, aceitaMensagemLivre: true };
    const primeira = deps({ canal });
    expect((await aplicaAvisoDeProposta(primeira.d, evento())).status).toBe("retry");
    const ultima = deps({ canal });
    const r = await aplicaAvisoDeProposta(ultima.d, evento({ attempts: 5 }));
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desconectado" });
    expect(ultima.audita).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.aviso_whatsapp_falhou" }));
  });

  it("canal PAUSADO pelo operador: não envia, não tenta de novo e audita a falha (#2318)", async () => {
    const canal = { id: "canal-1", status: "WORKING", archived_at: null, aceitaMensagemLivre: true, desativado: true };
    const { d, envia, audita } = deps({ canal });
    expect(await aplicaAvisoDeProposta(d, evento())).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(envia).not.toHaveBeenCalled();
    expect(audita).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.aviso_whatsapp_falhou" }));
  });

  it("espaçamento anti-bloqueio: tenta de novo quando o pacing libera", async () => {
    const liberaEm = new Date("2026-09-26T12:00:07.000Z");
    const { d, envia } = deps({ pacing: { liberado: false, motivo: "espacamento", liberaEm } });
    expect(await aplicaAvisoDeProposta(d, evento())).toMatchObject({ status: "retry", retry_at: liberaEm.toISOString() });
    expect(envia).not.toHaveBeenCalled();
  });

  it("envio recusado: tenta de novo; na 3ª desiste e audita", async () => {
    expect((await aplicaAvisoDeProposta(deps({ enviaFalha: true }).d, evento())).status).toBe("retry");
    const ultima = deps({ enviaFalha: true });
    expect((await aplicaAvisoDeProposta(ultima.d, evento({ attempts: 2 }))).status).toBe("skipped");
    expect(ultima.audita).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.aviso_whatsapp_falhou" }));
  });

  it("instalação sem endereço público: não envia link que não abre", async () => {
    const { d, envia } = deps({ urlPublica: "http://localhost:3000" });
    expect((await aplicaAvisoDeProposta(d, evento())).detail).toBe("sem_endereco_publico");
    expect(envia).not.toHaveBeenCalled();
  });
});
