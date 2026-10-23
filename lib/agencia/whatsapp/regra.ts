/**
 * A regra da entrega de uma mensagem do WhatsApp da agência
 * (docs/agencia/SPEC-whatsapp-agencia.md › Como funciona).
 *
 * Pura e testável com relógio, banco e transporte falsos — mesmo desenho de
 * `lib/escalacao/aviso-ao-suporte.ts`, cujo transporte e pacing são REUSADOS: o
 * WhatsApp da agência não ganha um segundo caminho de envio.
 *
 * ## Nenhum desfecho é `error`
 * Estado de mundo (sem configuração, canal fora do ar, número recusado) vira
 * `skipped` ou `retry`; `error` fica para defeito de programa, no `catch` do
 * handler. Senão toda instalação sem WhatsApp configurado acumularia eventos
 * mortos.
 *
 * ## A janela de horário vale só para AVISO
 * Convite e teste são disparados por uma pessoa naquele instante, olhando a
 * tela: segurá-los até as 7h faria o botão parecer quebrado. Aviso é que não
 * pode acordar ninguém (W2).
 */
import type { CanalDoAviso, PacingDoAviso, TransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte";

export type MotivoDoEnvio = "convite" | "aviso" | "teste";
export type SituacaoDoEnvio = "pendente" | "enviado" | "falhou" | "descartado";

export interface EnvioDaAgencia {
  id: string;
  motivo: MotivoDoEnvio;
  telefone: string;
  corpo: string;
  situacao: SituacaoDoEnvio;
  tentativas: number;
  criado_em: string;
}

export interface ConfigDoWhatsapp {
  organizationId: string | null;
  canalId: string | null;
  janelaInicio: string; // "07:00" ou "07:00:00"
  janelaFim: string;
}

export interface PatchDoEnvio {
  situacao?: SituacaoDoEnvio;
  tentativas?: number;
  erro_codigo?: string | null;
  external_id?: string | null;
  enviado_em?: string | null;
}

export interface DbDoWhatsapp {
  carregaEnvio(id: string): Promise<EnvioDaAgencia | null>;
  carregaConfig(): Promise<ConfigDoWhatsapp | null>;
  carregaCanal(organizationId: string, canalId: string): Promise<CanalDoAviso | null>;
  atualizaEnvio(id: string, patch: PatchDoEnvio): Promise<void>;
}

export interface DepsDoWhatsapp {
  db: DbDoWhatsapp;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  /** Fuso da janela de horário. A agência opera no Brasil. */
  fuso?: string;
}

export interface DesfechoDoEnvio {
  status: "ok" | "skipped" | "retry";
  retry_at?: string;
  detail: string;
}

/**
 * Quanto um AVISO espera antes de sair, para os avisos iguais que chegarem
 * nesse meio-tempo entrarem na mesma mensagem (SPEC-avisos, A4). Curto de
 * propósito: "você recebeu uma tarefa" que chega dez minutos depois já é tarde.
 */
export const AGRUPAMENTO_MS = 3 * 60 * 1000;
/** Mensagem que não saiu em 24 h não serve mais: é ruído. */
export const IDADE_MAXIMA_DO_ENVIO_MS = 24 * 60 * 60 * 1000;
/** Canal fora do ar: tenta de novo em 5 min, até o teto. */
export const ADIAMENTO_DO_CANAL_MS = 5 * 60 * 1000;
export const TETO_DE_TENTATIVAS_DO_CANAL = 6;
/** Transporte recusou o envio: tenta de novo em 2 min, até o teto. */
export const ADIAMENTO_DO_ENVIO_MS = 2 * 60 * 1000;
export const TETO_DE_TENTATIVAS_DE_ENVIO = 3;

const FUSO_PADRAO = "America/Sao_Paulo";

function minutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Hora do dia (em minutos) no fuso informado. */
function minutoDoDia(agora: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const h = Number(partes.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(partes.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function dentroDaJanela(agora: Date, inicio: string, fim: string, fuso = FUSO_PADRAO): boolean {
  const atual = minutoDoDia(agora, fuso);
  const a = minutos(inicio);
  const b = minutos(fim);
  // Janela que vira a noite (22:00–06:00) também é válida.
  return a <= b ? atual >= a && atual < b : atual >= a || atual < b;
}

/** O próximo instante em que a janela abre. */
export function proximaAbertura(agora: Date, inicio: string, fuso = FUSO_PADRAO): Date {
  const atual = minutoDoDia(agora, fuso);
  let faltam = minutos(inicio) - atual;
  if (faltam <= 0) faltam += 24 * 60;
  const alvo = new Date(agora.getTime() + faltam * 60_000);
  alvo.setUTCSeconds(0, 0);
  return alvo;
}

function skipped(detail: string): DesfechoDoEnvio {
  return { status: "skipped", detail };
}
function retry(quando: Date, detail: string): DesfechoDoEnvio {
  return { status: "retry", retry_at: quando.toISOString(), detail };
}

export async function aplicaEnvioDaAgencia(deps: DepsDoWhatsapp, envioId: string): Promise<DesfechoDoEnvio> {
  const agora = deps.clock();
  const fuso = deps.fuso ?? FUSO_PADRAO;
  const envio = await deps.db.carregaEnvio(envioId);
  if (!envio) return skipped("envio_inexistente");
  if (envio.situacao !== "pendente") return skipped(`ja_${envio.situacao}`);

  // 0. Aviso recém-criado espera o agrupamento: quem chegar até lá entra junto.
  const nasceu = new Date(envio.criado_em).getTime();
  if (envio.motivo === "aviso" && agora.getTime() - nasceu < AGRUPAMENTO_MS) {
    return retry(new Date(nasceu + AGRUPAMENTO_MS), "aguardando_agrupamento");
  }

  // 1. Velho demais: descarta (o sininho já guardou o aviso; o convite tem link na tela).
  const idade = agora.getTime() - new Date(envio.criado_em).getTime();
  if (idade > IDADE_MAXIMA_DO_ENVIO_MS) {
    await deps.db.atualizaEnvio(envio.id, { situacao: "descartado", erro_codigo: "envio_velho" });
    return skipped("envio_velho");
  }

  // 2. Configuração: sem canal escolhido não há por onde falar.
  const cfg = await deps.db.carregaConfig();
  if (!cfg?.organizationId || !cfg.canalId) {
    await deps.db.atualizaEnvio(envio.id, { situacao: "descartado", erro_codigo: "sem_configuracao" });
    return skipped("sem_configuracao");
  }

  // 3. Janela de horário — só para aviso.
  if (envio.motivo === "aviso" && !dentroDaJanela(agora, cfg.janelaInicio, cfg.janelaFim, fuso)) {
    return retry(proximaAbertura(agora, cfg.janelaInicio, fuso), "fora_da_janela");
  }

  // 4. O canal existe, está conectado e aceita mensagem livre?
  const canal = await deps.db.carregaCanal(cfg.organizationId, cfg.canalId);
  if (!canal || canal.archived_at || canal.desativado) {
    await deps.db.atualizaEnvio(envio.id, { situacao: "falhou", erro_codigo: "canal_indisponivel" });
    return skipped("canal_indisponivel");
  }
  if (!canal.aceitaMensagemLivre) {
    await deps.db.atualizaEnvio(envio.id, { situacao: "falhou", erro_codigo: "canal_sem_mensagem_livre" });
    return skipped("canal_sem_mensagem_livre");
  }
  if (!(await deps.transporte.configurado(cfg.organizationId, canal))) {
    const tentativas = envio.tentativas + 1;
    if (tentativas >= TETO_DE_TENTATIVAS_DO_CANAL) {
      await deps.db.atualizaEnvio(envio.id, { situacao: "falhou", tentativas, erro_codigo: "transporte_ausente" });
      return skipped("transporte_ausente");
    }
    await deps.db.atualizaEnvio(envio.id, { tentativas, erro_codigo: "transporte_ausente" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte_fora_do_ar");
  }

  // 5. Anti-bloqueio: espaçamento e teto diário do número.
  const pacing = await deps.pacing.decide(cfg.organizationId, cfg.canalId, agora);
  if (!pacing.liberado) return retry(pacing.liberaEm, `pacing_${pacing.motivo}`);

  // 6. Endereço do destinatário neste canal.
  const to = await deps.transporte.resolveDestino(cfg.organizationId, canal, envio.telefone);
  if (!to) {
    await deps.db.atualizaEnvio(envio.id, { situacao: "falhou", erro_codigo: "destino_invalido" });
    return skipped("destino_invalido");
  }

  // 7. O envio.
  try {
    const resposta = await deps.transporte.envia(cfg.organizationId, canal, to, envio.corpo);
    await deps.pacing.registraEnvio(cfg.organizationId, cfg.canalId, agora);
    await deps.db.atualizaEnvio(envio.id, {
      situacao: "enviado",
      tentativas: envio.tentativas + 1,
      erro_codigo: null,
      external_id: resposta.externalId,
      enviado_em: agora.toISOString(),
    });
    return { status: "ok", detail: "enviado" };
  } catch {
    const tentativas = envio.tentativas + 1;
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      await deps.db.atualizaEnvio(envio.id, { situacao: "falhou", tentativas, erro_codigo: "envio_recusado" });
      return skipped("envio_recusado");
    }
    await deps.db.atualizaEnvio(envio.id, { tentativas, erro_codigo: "envio_recusado" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_ENVIO_MS), "envio_recusado");
  }
}

/** O telefone para log e tela: só os 4 últimos dígitos. */
export function mascararTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  return d.length <= 4 ? "••••" : `••••${d.slice(-4)}`;
}
