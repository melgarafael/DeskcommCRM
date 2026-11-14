/**
 * A CONTA da revisão por quilometragem (issue #4376) — um lugar só.
 *
 * ═══ O BURACO QUE ELA FECHA ═══
 *
 * O pós-venda de uma concessionária vive de agendamento ativo:
 *
 *   1. quatro meses depois da retirada, uma mensagem pergunta a quilometragem;
 *   2. com o km respondido, projeta-se QUANDO ele chega aos 10 mil km — a
 *      revisão vence em 10 mil km OU 12 meses, o que vier primeiro;
 *   3. trinta dias antes dessa data, o CRM convida para agendar;
 *   4. a cada nova quilometragem o ritmo é refeito e a revisão seguinte
 *      (20 mil, 30 mil…) é projetada de novo.
 *
 * O passo 1 já se monta com a pergunta do roteiro (`captura-do-fluxo.ts`), e o
 * passo 3 já existe inteiro: o campo de data do negócio, o gatilho
 * `lead.date_field_due` com `dias` assinado (#989), o rearme pelo VALOR da data
 * (#1540) e a ação `set_lead_date_field` (#3727). O que faltava era o passo 2:
 * ninguém transformava "km informado" em "data prevista" — alguém teria de
 * fazer a conta de cabeça e digitar no card, e ninguém faz.
 *
 * ═══ POR QUE UMA FUNÇÃO PURA, E NÃO UM GATILHO NO BANCO ═══
 *
 * A issue (#4376) deixou a escolha aberta entre (a) gatilho em PL/pgSQL e (b)
 * função pura chamada nos pontos de escrita. Aqui a CONTA mora numa função pura
 * — sem banco, sem rede, sem `Date` do relógio — e quem grava é o caminho que já
 * existe (`fn_lead_anotar_campos`, o mesmo da ação `set_lead_date_field`).
 * Assim a régua é testável caso a caso, sem `test:db`, e o valor gravado é o
 * que a varredura do gatilho lê: como a chave de disparo leva o valor da data,
 * mudar a projeção REARMA o aviso sem nada novo no cron.
 *
 * ═══ A RÉGUA ═══
 *
 *   ritmo        = (km atual − km da última revisão) ÷ dias desde aquela data
 *   marco        = o próximo múltiplo do intervalo ACIMA do km atual
 *   data do km   = hoje + (marco − km atual) ÷ ritmo, arredondado para cima
 *   prazo        = data base + N meses (o teto que vale para quem roda pouco)
 *   data prevista= a MENOR das duas — "o que vier primeiro"
 *
 * A data base é a última revisão quando o funil guarda o km e o dia dela; sem
 * ela, é a retirada, com km zero. A cada quilometragem nova a conta refaz o
 * ritmo: o mesmo cliente que acelerou passa a ser projetado mais cedo.
 *
 * ═══ AS QUATRO BORDAS QUE MANDAM NO DESENHO ═══
 *
 *   1. km MENOR que o anterior é dedo no teclado: não projeta, não regride a
 *      data já gravada e não inventa ritmo negativo (`km_sem_avanco`);
 *   2. 12 meses vence ANTES dos 10 mil km de quem roda pouco: a data é o teto
 *      (`limitada_pelo_prazo`), não o marco;
 *   3. sem data de retirada (e sem revisão anterior) NÃO há projeção — e isso é
 *      resposta EXPLÍCITA (`sem_data_de_retirada`), não silêncio: quem chama
 *      registra o motivo em vez de deixar o card vazio sem explicação;
 *   4. cliente que roda muito projeta a revisão para daqui a poucos dias, e o
 *      aviso de 30 dias cairia no PASSADO — a varredura só emite no dia exato
 *      (`casaNaData`), então um aviso vencido nunca sairia. A data sobe para
 *      `hoje + dias de aviso` (`ajustada_pelo_aviso`), que é o dia em que o
 *      gatilho ainda dispara.
 */
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";

/** A chave da configuração dentro de `crm_pipelines.settings`. */
export const CONFIG_NO_FUNIL = "revisao_por_km";

/** Intervalo e prazo de fábrica — a régua de mercado que a issue descreve. */
export const INTERVALO_PADRAO_KM = 10000;
export const PRAZO_PADRAO_MESES = 12;
export const AVISO_PADRAO_DIAS = 30;

/**
 * O que o funil declara. Todos os campos são do NEGÓCIO (é o `custom_fields`
 * do card que a varredura lê) e todos já existem no funil: esta configuração
 * APONTA campos, não cria nenhum.
 */
export interface ConfigDeRevisaoPorKm {
  /** Campo `date` com o dia da retirada do veículo. */
  campo_retirada: string;
  /** Campo `number` com o km informado pelo cliente. */
  campo_km: string;
  /** Campo `date` de SAÍDA, onde a data prevista é gravada. */
  campo_saida: string;
  /** Opcional: campo `number` com o km da última revisão feita. */
  campo_km_da_ultima_revisao?: string;
  /** Opcional: campo `date` com o dia da última revisão feita. */
  campo_da_ultima_revisao?: string;
  /** De quantos em quantos km a revisão vence. */
  intervalo_km: number;
  /** Teto em meses, contados da data base. */
  prazo_meses: number;
  /** Quantos dias antes da data prevista o aviso sai (o `dias` da regra). */
  dias_de_aviso: number;
}

/** Por que a configuração do funil não serve — nomeado, nunca "deu erro". */
export type MotivoDeConfiguracaoInvalida =
  | "ausente"
  | "nao_e_objeto"
  | "campo_obrigatorio"
  | "campo_desconhecido_no_funil"
  | "campo_do_contato"
  | "tipo_do_campo"
  | "chaves_repetidas"
  | "intervalo_invalido"
  | "prazo_invalido"
  | "aviso_invalido";

export type LeituraDaConfiguracao =
  | { ok: true; config: ConfigDeRevisaoPorKm }
  | { ok: false; motivo: MotivoDeConfiguracaoInvalida; detalhe?: string };

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

function inteiro(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isInteger(valor)) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor.trim())) return Number(valor.trim());
  return null;
}

/**
 * Lê `pipelines.settings.revisao_por_km` e confere contra os campos do PRÓPRIO
 * funil.
 *
 * A conferência não é preciosismo: a varredura do gatilho lê
 * `crm_leads.custom_fields` e o campo do CONTATO (#2791) mora em
 * `contacts.custom_fields`. Uma configuração apontando para ele salvaria, o dia
 * chegaria, e nada sairia — a falha silenciosa que este arquivo existe para não
 * repetir. Funil sem a configuração devolve `ausente`: é o caso de TODO funil
 * que não usa a régua, e não é erro.
 */
export function configuracaoDeRevisaoPorKm(
  settings: Record<string, unknown> | null | undefined,
): LeituraDaConfiguracao {
  const bruto = settings ? settings[CONFIG_NO_FUNIL] : undefined;
  if (bruto === undefined || bruto === null) return { ok: false, motivo: "ausente" };
  if (typeof bruto !== "object" || Array.isArray(bruto)) {
    return { ok: false, motivo: "nao_e_objeto" };
  }

  const obj = bruto as Record<string, unknown>;
  const campoRetirada = texto(obj.campo_retirada);
  const campoKm = texto(obj.campo_km);
  const campoSaida = texto(obj.campo_saida);
  const campoKmUltima = texto(obj.campo_km_da_ultima_revisao);
  const campoDataUltima = texto(obj.campo_da_ultima_revisao);

  for (const [nome, valor] of [
    ["campo_retirada", campoRetirada],
    ["campo_km", campoKm],
    ["campo_saida", campoSaida],
  ] as const) {
    if (!valor) return { ok: false, motivo: "campo_obrigatorio", detalhe: nome };
  }
  // Os dois opcionais andam JUNTOS: km sem dia (ou dia sem km) não dá ritmo, e
  // aceitar meio par faria a conta cair na retirada sem avisar ninguém.
  if (Boolean(campoKmUltima) !== Boolean(campoDataUltima)) {
    return {
      ok: false,
      motivo: "campo_obrigatorio",
      detalhe: campoKmUltima ? "campo_da_ultima_revisao" : "campo_km_da_ultima_revisao",
    };
  }

  const chaves = [campoRetirada, campoKm, campoSaida, campoKmUltima, campoDataUltima].filter(
    (chave) => chave !== "",
  );
  if (new Set(chaves).size !== chaves.length) {
    return { ok: false, motivo: "chaves_repetidas" };
  }

  const defs = camposDoFunil(settings);
  const porChave = new Map(defs.map((definicao) => [definicao.key, definicao]));
  const esperados: Array<[string, string, "date" | "number"]> = [
    ["campo_retirada", campoRetirada, "date"],
    ["campo_km", campoKm, "number"],
    ["campo_saida", campoSaida, "date"],
  ];
  if (campoKmUltima) {
    esperados.push(["campo_km_da_ultima_revisao", campoKmUltima, "number"]);
    esperados.push(["campo_da_ultima_revisao", campoDataUltima, "date"]);
  }
  for (const [nome, chave, tipo] of esperados) {
    const definicao = porChave.get(chave);
    if (!definicao) {
      return { ok: false, motivo: "campo_desconhecido_no_funil", detalhe: `${nome}=${chave}` };
    }
    if (escopoDoCampo(definicao) !== "negocio") {
      return { ok: false, motivo: "campo_do_contato", detalhe: `${nome}=${chave}` };
    }
    if (definicao.type !== tipo) {
      return { ok: false, motivo: "tipo_do_campo", detalhe: `${nome}=${chave}:${definicao.type}` };
    }
  }

  const intervalo = inteiro(obj.intervalo_km);
  if (intervalo === null || intervalo <= 0 || intervalo > 200_000) {
    return { ok: false, motivo: "intervalo_invalido" };
  }
  const prazo = inteiro(obj.prazo_meses);
  if (prazo === null || prazo < 1 || prazo > 120) return { ok: false, motivo: "prazo_invalido" };
  const aviso = inteiro(obj.dias_de_aviso);
  if (aviso === null || aviso < 0 || aviso > 365) return { ok: false, motivo: "aviso_invalido" };

  return {
    ok: true,
    config: {
      campo_retirada: campoRetirada,
      campo_km: campoKm,
      campo_saida: campoSaida,
      ...(campoKmUltima ? { campo_km_da_ultima_revisao: campoKmUltima } : {}),
      ...(campoDataUltima ? { campo_da_ultima_revisao: campoDataUltima } : {}),
      intervalo_km: intervalo,
      prazo_meses: prazo,
      dias_de_aviso: aviso,
    },
  };
}

/** A configuração com os padrões de fábrica para o que o funil não declarou. */
export function configuracaoComPadroes(config: ConfigDeRevisaoPorKm): Required<ConfigDeRevisaoPorKm> {
  return {
    ...config,
    campo_km_da_ultima_revisao: config.campo_km_da_ultima_revisao ?? "",
    campo_da_ultima_revisao: config.campo_da_ultima_revisao ?? "",
    intervalo_km: config.intervalo_km || INTERVALO_PADRAO_KM,
    prazo_meses: config.prazo_meses || PRAZO_PADRAO_MESES,
    dias_de_aviso: config.dias_de_aviso === 0 ? AVISO_PADRAO_DIAS : config.dias_de_aviso,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendário puro — nada de `Date` do relógio da máquina
// ─────────────────────────────────────────────────────────────────────────────
//
// Toda data daqui é `AAAA-MM-DD`, sempre no fuso da ORGANIZAÇÃO (quem chama já
// converte com `diaLocal`). Trabalhar com o dia de parede evita a classe de
// defeito em que a conta "anda um dia" porque o servidor está em UTC.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function partes(dia: string): { ano: number; mes: number; dia: number } | null {
  const m = ISO.exec(dia.trim());
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(ano) || ano < 1900 || ano > 2200) return null;
  if (mes < 1 || mes > 12) return null;
  if (d < 1 || d > 31) return null;
  const teste = new Date(Date.UTC(ano, mes - 1, d));
  if (teste.getUTCFullYear() !== ano || teste.getUTCMonth() !== mes - 1 || teste.getUTCDate() !== d) {
    return null;
  }
  return { ano, mes, dia: d };
}

/** A data em `AAAA-MM-DD`, ou `null` para o que não é data de calendário. */
export function diaValido(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const p = partes(valor);
  if (!p) return null;
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

function emUtc(dia: string): Date {
  const p = partes(dia)!;
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia));
}

function deUtc(data: Date): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${data.getUTCFullYear()}-${dois(data.getUTCMonth() + 1)}-${dois(data.getUTCDate())}`;
}

/** Dias inteiros de `de` até `ate` (negativo quando `ate` é antes). */
export function diasEntre(de: string, ate: string): number | null {
  const a = diaValido(de);
  const b = diaValido(ate);
  if (!a || !b) return null;
  return Math.round((emUtc(b).getTime() - emUtc(a).getTime()) / 86_400_000);
}

/** `dia` somado a `n` dias. `null` se `dia` não for data. */
export function somarDias(dia: string, n: number): string | null {
  const base = diaValido(dia);
  if (!base || !Number.isInteger(n)) return null;
  const data = emUtc(base);
  data.setUTCDate(data.getUTCDate() + n);
  return deUtc(data);
}

/**
 * `dia` somado a `n` MESES de calendário, com o dia preso ao fim do mês.
 *
 * `2026-01-31 + 1 mês` é `2026-02-28`, não `2026-03-03`: prazo de 12 meses é
 * aniversário, não 365 dias corridos.
 */
export function somarMeses(dia: string, n: number): string | null {
  const base = diaValido(dia);
  if (!base || !Number.isInteger(n)) return null;
  const p = partes(base)!;
  const alvo = new Date(Date.UTC(p.ano, p.mes - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(p.dia, ultimoDia));
  return deUtc(alvo);
}

// ─────────────────────────────────────────────────────────────────────────────
// A conta
// ─────────────────────────────────────────────────────────────────────────────

/** Um km lido do `custom_fields` — número ou o texto que o formulário grava. */
export function kmDoCampo(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) && valor >= 0 ? valor : null;
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  if (limpo === "") return null;
  // "12.000" (milhar BR), "12000", "12000,5" (decimal BR) — e nada além disso:
  // "uns 12 mil" é texto livre, e quem o interpreta é o modelo, não esta conta.
  const semMilhar = /^\d{1,3}(\.\d{3})+$/.test(limpo) ? limpo.replace(/\./g, "") : limpo;
  const comPonto = semMilhar.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(comPonto)) return null;
  const numero = Number(comPonto);
  return Number.isFinite(numero) && numero >= 0 ? numero : null;
}

export type ResultadoDaProjecao =
  | { status: "sem_configuracao" }
  | { status: "configuracao_invalida"; motivo: MotivoDeConfiguracaoInvalida; detalhe?: string }
  | { status: "sem_km" }
  | { status: "sem_data_de_retirada" }
  | { status: "sem_ritmo"; motivo: "leitura_no_mesmo_dia" | "data_base_no_futuro" }
  | {
      status: "km_sem_avanco";
      /** O km que chegou e o que já estava registrado — para a trilha, não para a data. */
      km_atual: number;
      km_base: number;
      /** A data que já estava no card continua valendo (null = não havia). */
      data_mantida: string | null;
    }
  | {
      status: "projetada";
      /** `AAAA-MM-DD` a gravar no campo de saída. */
      data: string;
      /** O dia em que o aviso de N dias sai (`data − dias_de_aviso`). */
      dia_do_aviso: string;
      /** O marco de km que a revisão atende (10 000, 20 000…). */
      marco_km: number;
      km_atual: number;
      km_base: number;
      data_base: string;
      /** Km por dia, com uma casa decimal — o que a conta usou. */
      ritmo_km_por_dia: number;
      dias_ate_a_revisao: number;
      /** `12 meses` venceu antes do marco. */
      limitada_pelo_prazo: boolean;
      /** O aviso cairia no passado e a data subiu para `hoje + dias de aviso`. */
      ajustada_pelo_aviso: boolean;
      /** O campo de saída já tem exatamente esta data: não há o que gravar. */
      ja_gravada: boolean;
    };

export interface EntradaDaProjecao {
  config: ConfigDeRevisaoPorKm;
  /** `crm_leads.custom_fields` como está no banco. */
  campos: Record<string, unknown>;
  /** O dia da leitura no fuso da organização (`AAAA-MM-DD`). */
  hoje: string;
}

/**
 * A conta inteira, pura: km atual + data de retirada (+ km da última revisão)
 * → data prevista da próxima revisão.
 *
 * Devolve SEMPRE um resultado nomeado. `sem_data_de_retirada` e `sem_km` não
 * são falhas: são o retrato de um card que ainda não tem o dado, e quem chama
 * registra o motivo em vez de inventar uma data.
 */
export function projetarProximaRevisao(entrada: EntradaDaProjecao): ResultadoDaProjecao {
  const { config, campos } = entrada;
  const hoje = diaValido(entrada.hoje);
  if (!hoje) return { status: "sem_ritmo", motivo: "leitura_no_mesmo_dia" };

  const kmAtual = kmDoCampo(campos[config.campo_km]);
  if (kmAtual === null) return { status: "sem_km" };

  // ─── A data BASE: a última revisão quando o funil a guarda; senão, a retirada
  const dataUltima = config.campo_da_ultima_revisao
    ? diaValido(campos[config.campo_da_ultima_revisao])
    : null;
  const kmUltima = config.campo_km_da_ultima_revisao
    ? kmDoCampo(campos[config.campo_km_da_ultima_revisao])
    : null;
  const revisaoAnterior =
    dataUltima !== null && kmUltima !== null && diasEntre(dataUltima, hoje)! >= 0
      ? { data: dataUltima, km: kmUltima }
      : null;

  const dataRetirada = diaValido(campos[config.campo_retirada]);
  const base = revisaoAnterior ?? (dataRetirada ? { data: dataRetirada, km: 0 } : null);
  // Borda 3: sem base não há conta — e a resposta é EXPLÍCITA.
  if (!base) return { status: "sem_data_de_retirada" };

  const dias = diasEntre(base.data, hoje);
  if (dias === null || dias < 0) return { status: "sem_ritmo", motivo: "data_base_no_futuro" };
  if (dias === 0) return { status: "sem_ritmo", motivo: "leitura_no_mesmo_dia" };

  // Borda 1: km menor que o anterior é digitação errada. Não projeta, não
  // regride a data já gravada e não produz ritmo negativo.
  if (kmAtual < base.km) {
    return {
      status: "km_sem_avanco",
      km_atual: kmAtual,
      km_base: base.km,
      data_mantida: diaValido(campos[config.campo_saida]),
    };
  }

  const dataDoPrazo = somarMeses(base.data, config.prazo_meses)!;
  const ritmo = (kmAtual - base.km) / dias;

  // O próximo marco: o múltiplo do intervalo ESTRITAMENTE acima do km atual.
  const marco = (Math.floor(kmAtual / config.intervalo_km) + 1) * config.intervalo_km;
  const diasAteMarco = ritmo > 0 ? Math.ceil((marco - kmAtual) / ritmo) : null;
  const dataDoMarco = diasAteMarco === null ? null : somarDias(hoje, diasAteMarco);

  // Borda 2: "10 mil km OU 12 meses, o que vier primeiro". Sem ritmo (km igual ao
  // da base) o prazo sozinho decide — quem não roda ainda vence no aniversário.
  const limitadaPeloPrazo = dataDoMarco === null || dataDoPrazo < dataDoMarco;
  let data = limitadaPeloPrazo ? dataDoPrazo : dataDoMarco!;

  // Borda 4: a varredura do gatilho só emite no dia EXATO (`casaNaData`), então
  // um aviso cuja data já passou nunca sairia. O piso mantém o aviso vivo hoje.
  const pisoDoAviso = somarDias(hoje, config.dias_de_aviso)!;
  const ajustadaPeloAviso = data < pisoDoAviso;
  if (ajustadaPeloAviso) data = pisoDoAviso;

  const diasAteARevisao = diasEntre(hoje, data)!;
  return {
    status: "projetada",
    data,
    dia_do_aviso: somarDias(data, -config.dias_de_aviso)!,
    marco_km: marco,
    km_atual: kmAtual,
    km_base: base.km,
    data_base: base.data,
    ritmo_km_por_dia: Math.round(ritmo * 10) / 10,
    dias_ate_a_revisao: diasAteARevisao,
    limitada_pelo_prazo: limitadaPeloPrazo,
    ajustada_pelo_aviso: ajustadaPeloAviso,
    ja_gravada: diaValido(campos[config.campo_saida]) === data,
  };
}
