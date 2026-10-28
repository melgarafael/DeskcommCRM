/**
 * OUVIDORIA — O REGISTRO DA MANIFESTAÇÃO (#3611, fatia 1).
 *
 * ─── O defeito que esta camada fecha ────────────────────────────────────────
 *
 * Hoje a única forma de "guardar" o relato de alguém que reclama da empresa é
 * abrir um cartão no funil — e cartão no funil é oportunidade de venda: aparece
 * na previsão comercial, no relatório do vendedor, na fila do SDR, e some do
 * lugar onde a ouvidoria procuraria. A #3611 pede o contrário: registro PRÓPRIO,
 * com protocolo, privado, sem tocar no funil.
 *
 * ─── O que esta fatia entrega, e o que NÃO entrega ──────────────────────────
 *
 * Entrega: a gravação (`registrarManifestacao`) — uma linha em
 * `ouvidoria_manifestacoes` com protocolo gerado AQUI — e o contrato de leitura
 * (`lib/ouvidoria/leitura.ts`). A gravação é a peça que a fatia 2 (conversa pelo
 * WhatsApp) chama; ela não conhece canal nenhum, não fala HTTP e não decide
 * quem pode falar com quem.
 *
 * Fica FORA, declarado no PR: fluxo de conversa pelo WhatsApp, anexos,
 * notificação por e-mail, tela de gestão e a configuração de PERFIS
 * autorizados. Enquanto a configuração de perfis não existe, a leitura é de
 * `admin` para cima — a mais restritiva das opções que a issue lista.
 *
 * ─── Três garantias que este arquivo existe para provar ─────────────────────
 *
 * 1. **O protocolo é do SERVIDOR.** O schema de entrada é `strictObject` e NÃO
 *    tem campo `protocolo`: quem tentar mandar um, recebe `validacao` e nada é
 *    gravado (não é "ignorado em silêncio", é recusado). A forma do valor e a
 *    unicidade por organização são cobradas de novo pelo banco (CHECK + índice
 *    único da migration 9030) — três cercas para o mesmo fato.
 *
 * 2. **Registrar NÃO cria negócio no funil.** É o controle central da issue. O
 *    corpo desta função escreve em UMA tabela; o teste de unidade reprova
 *    qualquer escrita fora de `ouvidoria_manifestacoes` e qualquer leitura de
 *    `crm_leads`/`crm_pipelines`/`crm_stages`. Não há caminho alternativo: a
 *    tabela não tem FK, gatilho ou coluna que chegue ao funil.
 *
 * 3. **Desligado não recebe.** Só o `true` explícito de
 *    `organizations.settings.ouvidoria.ativa` abre a porta (a régua de
 *    `ouvidoriaLigada`); ausente/lixo = `modulo_desligado`, nenhuma linha.
 *
 * ─── Multi-tenant sem sessão ────────────────────────────────────────────────
 *
 * A gravação roda com o cliente de SERVIÇO (o canal não tem JWT), então a RLS
 * não separa nada neste caminho: o `organization_id` vem do chamador — que na
 * fatia 2 é o número conectado, nunca o corpo de uma mensagem — e o predicado
 * `.eq("organization_id", …)` no contato e o valor gravado na linha são a única
 * cerca. Por isso o teste de unidade fixa esse predicado.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { ouvidoriaLigada } from "@/lib/schemas/settings";

/** Os canais que a fatia 1 aceita — os mesmos do CHECK da migration 9030. */
export const CANAIS_DA_OUVIDORIA = [
  "whatsapp",
  "web",
  "email",
  "telefone",
  "presencial",
  "outro",
] as const;

export type CanalDaOuvidoria = (typeof CANAIS_DA_OUVIDORIA)[number];

/** Os estados da manifestação — os mesmos do CHECK da migration 9030. */
export const STATUS_DA_OUVIDORIA = ["recebida", "em_analise", "concluida"] as const;

export type StatusDaOuvidoria = (typeof STATUS_DA_OUVIDORIA)[number];

/** O piso e o teto do relato; os mesmos da CHECK `texto` da 9030. */
export const TEXTO_MINIMO = 1;
export const TEXTO_MAXIMO = 20000;

/**
 * O que o registro aceita — e o que ele NÃO aceita.
 *
 * `strictObject` de propósito: `protocolo`, `status` e `organization_id` não são
 * campos do pedido. Um objeto com `protocolo` reprova inteiro (e o teste
 * aproveita isso para provar que o número não vem de fora); `status` idem, porque
 * manifestação nasce `recebida` e a transição é da tela de gestão.
 */
export const manifestacaoSchema = z.strictObject({
  texto: z.string().trim().min(TEXTO_MINIMO).max(TEXTO_MAXIMO),
  canal: z.enum(CANAIS_DA_OUVIDORIA),
  /** Opcional: o contato do CRM que relatou. `null`/ausente = relato anônimo. */
  contactId: z.uuid().nullable().optional(),
});

export type NovaManifestacao = z.infer<typeof manifestacaoSchema>;

export interface ManifestacaoRegistrada {
  id: string;
  protocolo: string;
  status: StatusDaOuvidoria;
  createdAt: string;
}

export type ResultadoDoRegistro =
  | { ok: true; manifestacao: ManifestacaoRegistrada }
  | {
      ok: false;
      erro: "validacao" | "modulo_desligado" | "contato_invalido" | "erro_ao_gravar";
    };

export interface DepsDaOuvidoria {
  supabase: SupabaseClient;
  /** A organização do canal que recebeu o relato — NUNCA de argumento do pedido. */
  organizationId: string;
}

/**
 * Gera o protocolo da manifestação. `OUV-AAAAMMDD-XXXXXXXX`.
 *
 * O dia é o de UTC de propósito: o protocolo é identificador, não data de
 * exibição — a tela mostra `created_at` no fuso da organização. Um protocolo
 * que mudasse de dia conforme o fuso de quem olha seria dois números para o
 * mesmo fato, e é exatamente o que a pessoa anota no papel.
 *
 * `bytes` é injetável para o teste poder fixar o valor; quem chama em produção
 * não passa nada.
 */
export function gerarProtocolo(
  agora: Date = new Date(),
  bytes: () => Buffer = () => randomBytes(4),
): string {
  const dia = [
    agora.getUTCFullYear().toString().padStart(4, "0"),
    (agora.getUTCMonth() + 1).toString().padStart(2, "0"),
    agora.getUTCDate().toString().padStart(2, "0"),
  ].join("");
  return `OUV-${dia}-${bytes().toString("hex").toUpperCase()}`;
}

/** O erro do PostgREST para violação de unicidade. */
const UNICIDADE_VIOLADA = "23505";

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A organização aceita manifestações agora? `false` também quando a leitura
 * falhou — falha fechada, como `capacidadesDaOrganizacao`: um banco fora do ar
 * não pode virar "pode gravar".
 */
async function moduloAceitaRegistro(
  deps: DepsDaOuvidoria,
): Promise<{ aceita: boolean; falhou: boolean }> {
  const { data, error } = await deps.supabase
    .from("organizations")
    .select("settings")
    .eq("id", deps.organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[ouvidoria] leitura da ativação falhou — tratando o módulo como desligado", {
      organization_id: deps.organizationId,
      error: error.message,
    });
    return { aceita: false, falhou: true };
  }

  return { aceita: ouvidoriaLigada(objeto(data)?.settings), falhou: false };
}

/** O contato, se veio, tem de ser DESTA organização. */
async function contatoDaOrganizacao(
  deps: DepsDaOuvidoria,
  contactId: string,
): Promise<{ existe: boolean; falhou: boolean }> {
  const { data, error } = await deps.supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    logger.warn("[ouvidoria] conferência do contato falhou no registro", {
      organization_id: deps.organizationId,
      error: error.message,
    });
    return { existe: false, falhou: true };
  }

  return { existe: data !== null && data !== undefined, falhou: false };
}

/**
 * Registra a manifestação e devolve o protocolo.
 *
 * Devolve RESULTADO, não exceção: quem chama é o turno do canal, onde uma
 * exceção derruba o atendimento inteiro — o relato não registrado precisa
 * virar uma frase para a pessoa ("não conseguimos registrar, tente de novo"),
 * não um 500.
 */
export async function registrarManifestacao(
  deps: DepsDaOuvidoria,
  entrada: unknown,
): Promise<ResultadoDoRegistro> {
  // O tipo do parâmetro não chega ao servidor quando a chamada vem de fora; a
  // validação que vale é esta, e ela recusa `protocolo`/`status` de fora.
  const lido = manifestacaoSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, erro: "validacao" };

  const ativacao = await moduloAceitaRegistro(deps);
  if (ativacao.falhou) return { ok: false, erro: "erro_ao_gravar" };
  if (!ativacao.aceita) return { ok: false, erro: "modulo_desligado" };

  const contactId = lido.data.contactId ?? null;
  if (contactId) {
    const contato = await contatoDaOrganizacao(deps, contactId);
    if (contato.falhou) return { ok: false, erro: "erro_ao_gravar" };
    if (!contato.existe) return { ok: false, erro: "contato_invalido" };
  }

  // Uma tentativa, e uma repetição SÓ para colisão de protocolo: o índice único
  // é por organização e a chance de repetir 4 bytes é 1 em 4 bilhões, mas um
  // laço que não existe é o mesmo defeito de uma constraint que ninguém lê.
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const protocolo = gerarProtocolo();
    const { data, error } = await deps.supabase
      .from("ouvidoria_manifestacoes")
      .insert({
        organization_id: deps.organizationId,
        protocolo,
        canal: lido.data.canal,
        texto: lido.data.texto,
        contact_id: contactId,
        status: "recebida",
      })
      .select("id, protocolo, status, created_at")
      .single();

    if (!error) {
      const linha = objeto(data);
      if (!linha) return { ok: false, erro: "erro_ao_gravar" };
      return {
        ok: true,
        manifestacao: {
          id: String(linha.id),
          protocolo: String(linha.protocolo),
          status: linha.status as StatusDaOuvidoria,
          createdAt: String(linha.created_at),
        },
      };
    }

    if (error.code === UNICIDADE_VIOLADA && tentativa === 0) continue;

    logger.error("[ouvidoria] a gravação da manifestação falhou", {
      organization_id: deps.organizationId,
      code: error.code,
      error: error.message.slice(0, 120),
    });
    return { ok: false, erro: "erro_ao_gravar" };
  }

  return { ok: false, erro: "erro_ao_gravar" };
}
