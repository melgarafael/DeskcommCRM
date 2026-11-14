// lib/propostas/documento/negocio-do-documento.ts
/**
 * A QUARTA FONTE do documento da proposta: o NEGÓCIO (#4533).
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * `montarDadosDoDocumento` juntava briefing, proposta e contato. Os campos
 * personalizados do CARD (`crm_leads.custom_fields`, definidos em
 * `pipelines.settings.fields`) não entravam, mesmo a proposta já tendo
 * `lead_id`: quem vende por funil digitava de novo no texto da proposta o que
 * já estava no negócio — endereço do imóvel, valor do aluguel, data de entrada.
 *
 * A sintaxe é a MESMA que o follow-up usa para campo do funil
 * (`anexarCamposDoFunil`, `lib/automation/campos-do-render.ts`):
 * `{{lead.<chave>}}`, mais `lead.titulo`, `lead.etapa`,
 * `lead.responsavel_nome` e `lead.responsavel_telefone`.
 *
 * ─── AS RÉGUAS, e por que são estas ────────────────────────────────────────
 *
 * 1. **FORMATO PELO TIPO do campo** — `currency` em moeda, `date` em
 *    dd/mm/aaaa, `boolean` em Sim/Não, `select`/`multiselect` pelo RÓTULO da
 *    opção (`valorComRotulo`) e lista unida pelo separador que o domínio já usa
 *    (`SEPARADOR_DAS_OPCOES`). Nada de segunda régua: quem escreve o card e
 *    quem lê a proposta veem o mesmo texto.
 * 2. **O MOEDA GUARDADO É UNIDADE, NÃO CENTAVO.** O campo `currency` grava
 *    `1250.5` (`lib/leads/campo-de-moeda.ts`) — por isso a leitura passa por
 *    `valorDoCampoDeMoeda`, que é `formatCents` sobre os centavos DEPOIS do
 *    ×100. Ler o número cru como centavo mostraria cem vezes menos.
 * 3. **CAMPO VAZIO NÃO ENTRA.** Chave ausente do objeto devolvido é o que faz
 *    `substituirVariaveis` escrever "[a definir]" e registrar a pendência
 *    (`faltantes` → `camposFaltando`), mantendo a trava de envio valendo. String
 *    vazia no lugar do valor seria pior: passaria pela trava e imprimiria nada.
 * 4. **LEITURA DE APOIO NUNCA DERRUBA A RENDERIZAÇÃO.** Sem `lead_id`, sem
 *    linha, com o banco recusando ou com o funil ilegível, a resposta é `null`
 *    e o dataset fica EXATAMENTE como era antes da #4533 — nenhum `lead` no
 *    contexto, nenhuma exceção.
 * 5. **SEMPRE FILTRADO POR `organization_id`.** Esta leitura roda com o cliente
 *    de serviço (fora da RLS); o filtro de organização em CADA consulta é o que
 *    impede um id de outro tenant de atravessar a fronteira.
 *
 * Fora do escopo (declarado na issue): layout do PDF por empresa. Nenhuma
 * migration — `crm_leads`, `crm_pipelines`, `crm_stages` e `user_organizations`
 * já existem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { anexarCamposDoFunil, valorComRotulo } from "@/lib/automation/campos-do-render";
import { semAMoeda, valorDoCampoDeMoeda } from "@/lib/leads/campo-de-moeda";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { formatCents, parseReaisToCents } from "@/lib/money";
import type { CustomFieldDef } from "@/lib/schemas/settings";
import { nomesDosAtendentesCom } from "@/lib/users/nome-do-atendente";

import { rotulosDoNegocio } from "./rotulos-das-variaveis";

/** O que a leitura do card precisa entregar — e o rótulo de cada variável. */
export interface NegocioDoDocumento {
  /** `{{lead.<chave>}}` já formatado pelo tipo; chave vazia NÃO aparece. */
  dados: Record<string, unknown>;
  /** `lead.<chave>` → o rótulo que a empresa deu ao campo (editor e pendências). */
  rotulos: Record<string, string>;
}

/** A linha do negócio como o documento a lê. */
export interface NegocioParaDocumento {
  titulo: string | null;
  etapa: string | null;
  responsavel_nome: string | null;
  responsavel_telefone: string | null;
  /** `crm_leads.currency` — a moeda em que o campo `currency` foi digitado. */
  moeda: string | null;
  custom_fields: unknown;
}

/** Texto com conteúdo depois do `trim`; `null` para null/branco/não-texto. */
function textoComConteudo(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo === "" ? null : limpo;
}

/** O `custom_fields` como record tolerante — lixo vira objeto vazio. */
function camposGravados(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
}

/**
 * `YYYY-MM-DD` → `dd/mm/aaaa`.
 *
 * Só a forma de calendário, sem fuso: campo de data do funil é um DIA
 * (`valorDoTipoAceitavel`, #3316), e converter um dia sem hora é como se ganha
 * e se perde um dia. Data que não existe (`2026-02-31`) ou valor que não é ISO
 * voltam como vieram — inventar seria pior que mostrar o que está gravado.
 */
function diaMesAno(valor: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  const existe =
    data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
  return existe ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Centavos em moeda — o caminho do valor que veio como TEXTO digitado. */
function moedaDoTexto(valor: string, moeda: string): string | null {
  const cents = parseReaisToCents(semAMoeda(valor, moeda), moeda);
  return cents === null ? null : formatCents(cents, moeda);
}

/**
 * O valor de UM campo, pelo TIPO declarado no funil — ou `null` para vazio.
 *
 * Lista passa por `valorComRotulo` com o contexto já hidratado, que é a mesma
 * tradução `value` → `label` das mensagens de follow-up.
 */
function textoDoCampo(
  campo: CustomFieldDef,
  valor: unknown,
  contexto: Record<string, unknown>,
  moeda: string,
): string | null {
  if (valor === null || valor === undefined) return null;
  if (Array.isArray(valor) && valor.length === 0) return null;

  switch (campo.type) {
    case "currency": {
      if (typeof valor === "number" && Number.isFinite(valor)) return valorDoCampoDeMoeda(valor, moeda);
      if (typeof valor === "string") return moedaDoTexto(valor, moeda) ?? textoComConteudo(valor);
      return null;
    }
    case "date": {
      if (typeof valor !== "string") return null;
      return diaMesAno(valor) ?? textoComConteudo(valor);
    }
    case "boolean": {
      if (typeof valor === "boolean") return valor ? "Sim" : "Não";
      // jsonb de importação pode trazer o booleano como texto.
      const texto = textoComConteudo(valor);
      if (texto === "true") return "Sim";
      if (texto === "false") return "Não";
      return texto;
    }
    case "select":
    case "multiselect":
    case "searchable_select": {
      const comRotulo = valorComRotulo(contexto, campo.key, valor);
      if (Array.isArray(comRotulo)) {
        const lista = comRotulo.filter((item): item is string => typeof item === "string" && item.trim() !== "");
        return lista.length > 0 ? lista.join(", ") : null;
      }
      return textoComConteudo(comRotulo);
    }
    case "number": {
      if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
      return textoComConteudo(valor);
    }
    default:
      return textoComConteudo(valor);
  }
}

/**
 * O objeto `lead` do dataset — PURO, para o comportamento ser testável sem
 * banco. As chaves vazias ficam de fora de propósito: é a ausência que vira
 * "[a definir]" em `substituirVariaveis`.
 */
export function dadosDoNegocio(
  negocio: NegocioParaDocumento,
  settings: Record<string, unknown> | null | undefined,
  moedaDaProposta: string,
): Record<string, unknown> {
  const saida: Record<string, unknown> = {};

  const titulo = textoComConteudo(negocio.titulo);
  if (titulo !== null) saida.titulo = titulo;
  const etapa = textoComConteudo(negocio.etapa);
  if (etapa !== null) saida.etapa = etapa;
  const responsavelNome = textoComConteudo(negocio.responsavel_nome);
  if (responsavelNome !== null) saida.responsavel_nome = responsavelNome;
  const responsavelTelefone = textoComConteudo(negocio.responsavel_telefone);
  if (responsavelTelefone !== null) saida.responsavel_telefone = responsavelTelefone;

  const gravados = camposGravados(negocio.custom_fields);
  const declarados = camposPorEscopo(camposDoFunil(settings), "negocio").filter(
    // Arquivo não é valor no jsonb: o anexo mora em `crm_lead_attachments`.
    (campo) => campo.type !== "file",
  );

  const contexto: Record<string, unknown> = {};
  anexarCamposDoFunil(contexto, declarados);

  // A moeda do campo é a do NEGÓCIO (como no card); a da proposta é o
  // fallback para funil/moeda que a linha não declarou.
  const moeda = textoComConteudo(negocio.moeda) ?? moedaDaProposta;

  for (const campo of declarados) {
    const texto = textoDoCampo(campo, gravados[campo.key], contexto, moeda);
    if (texto !== null) saida[campo.key] = texto;
  }

  // Chave GRAVADA que o funil não declara (campo removido depois, importação
  // por API): entra pelo valor cru — a chave existe no card e o modelo pode
  // citá-la; sem definição não há tipo para formatar.
  for (const [chave, valor] of Object.entries(gravados)) {
    if (Object.hasOwn(saida, chave)) continue;
    if (declarados.some((campo) => campo.key === chave)) continue;
    const texto = Array.isArray(valor)
      ? valor.filter((item) => typeof item === "string" && item.trim() !== "").join(", ")
      : textoComConteudo(valor) ?? (typeof valor === "number" && Number.isFinite(valor) ? String(valor) : null);
    if (texto !== null && texto !== "") saida[chave] = texto;
  }

  return saida;
}

/** O `settings` do funil, filtrado pela organização; `null` quando ilegível. */
async function settingsDoFunil(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string | null,
): Promise<Record<string, unknown> | null> {
  if (!pipelineId) return null;
  const { data } = await db
    .from("crm_pipelines")
    .select("settings")
    .eq("organization_id", organizationId)
    .eq("id", pipelineId)
    .maybeSingle();
  const settings = (data as { settings?: unknown } | null)?.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : null;
}

/** O nome da ETAPA do card, filtrado pela organização. */
async function nomeDaEtapa(
  db: SupabaseClient,
  organizationId: string,
  stageId: string | null,
): Promise<string | null> {
  if (!stageId) return null;
  const { data } = await db
    .from("crm_stages")
    .select("name")
    .eq("organization_id", organizationId)
    .eq("id", stageId)
    .maybeSingle();
  return textoComConteudo((data as { name?: unknown } | null)?.name);
}

/**
 * O WhatsApp do responsável — `user_organizations.whatsapp_e164`, o único
 * telefone de um membro que o produto guarda (o mesmo número do aviso de caso).
 *
 * LGPD: só o número DECLARADO pela própria pessoa na equipe; nada de e-mail,
 * `user_metadata` ou telefone de contato.
 */
async function whatsappDoResponsavel(
  db: SupabaseClient,
  organizationId: string,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const { data } = await db
    .from("user_organizations")
    .select("whatsapp_e164")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  return textoComConteudo((data as { whatsapp_e164?: unknown } | null)?.whatsapp_e164);
}

interface LinhaDoNegocio {
  title?: unknown;
  stage_id?: unknown;
  owner_user_id?: unknown;
  pipeline_id?: unknown;
  custom_fields?: unknown;
  currency?: unknown;
}

/**
 * Lê o NEGÓCIO da proposta e devolve o dataset `lead` + os rótulos.
 *
 * `null` em TODOS os caminhos de falha (sem `lead_id`, sem linha, banco
 * recusando, exceção inesperada): leitura de apoio não pode derrubar a
 * renderização — a proposta continua saindo com as três fontes de antes.
 */
export async function lerNegocioDoDocumento(
  db: SupabaseClient,
  organizationId: string,
  leadId: string | null | undefined,
  moedaDaProposta: string,
): Promise<NegocioDoDocumento | null> {
  if (!leadId) return null;
  try {
    const { data, error } = await db
      .from("crm_leads")
      .select("title, stage_id, owner_user_id, pipeline_id, custom_fields, currency")
      .eq("organization_id", organizationId)
      .eq("id", leadId)
      .maybeSingle();
    if (error) return null;
    const linha = (data ?? null) as LinhaDoNegocio | null;
    if (!linha) return null;

    const pipelineId = textoComConteudo(linha.pipeline_id);
    const stageId = textoComConteudo(linha.stage_id);
    const userId = textoComConteudo(linha.owner_user_id);

    const [settings, etapa, nomes, telefone] = await Promise.all([
      settingsDoFunil(db, organizationId, pipelineId),
      nomeDaEtapa(db, organizationId, stageId),
      userId ? nomesDosAtendentesCom(db, organizationId, [userId]) : Promise.resolve(new Map<string, string | null>()),
      whatsappDoResponsavel(db, organizationId, userId),
    ]);

    const negocio: NegocioParaDocumento = {
      titulo: textoComConteudo(linha.title),
      etapa,
      responsavel_nome: userId ? (nomes.get(userId) ?? null) : null,
      responsavel_telefone: telefone,
      moeda: textoComConteudo(linha.currency),
      custom_fields: linha.custom_fields,
    };

    return {
      dados: dadosDoNegocio(negocio, settings, moedaDaProposta),
      rotulos: rotulosDoNegocio(camposPorEscopo(camposDoFunil(settings), "negocio")),
    };
  } catch {
    // Silencioso por desenho: o documento de hoje já tem uma leitura de apoio
    // a menos, e o cliente continua recebendo a proposta.
    return null;
  }
}
