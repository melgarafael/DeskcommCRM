/**
 * GET/PUT /api/v1/ai/cases/alerta — a configuração do aviso de caso no WhatsApp
 * da equipe (migration 0292).
 *
 * ## A escrita é do RPC, e a rota não escreve UMA linha na tabela
 *
 * `fn_definir_aviso_de_caso` faz, dentro da MESMA transação da escrita, sete
 * guardas que uma rota faria em sete idas ao banco com uma janela de corrida
 * entre cada duas: papel, suporte, MFA, E.164, canal da organização, recusa do
 * número da própria organização e recusa de número que já é um cliente. Um
 * `upsert` daqui repetiria as sete e divergiria delas no primeiro dia em que
 * alguém mudasse uma.
 *
 * ## …E mesmo assim a rota chama `requireSupportWrite()` na primeira linha
 *
 * A guarda de suporte JÁ está dentro do RPC (`fn_support_write_allowed`), e
 * isso é correto no banco e **invisível** para o gate que varre este arquivo:
 * `tests/unit/suporte-cobertura-de-efeitos.test.ts` casa o TEXTO de todo
 * handler mutante de `app/api/v1/**` procurando a chamada literal. Sem ela o CI
 * reprova o arquivo — e o gate está certo, porque a próxima versão desta rota
 * pode deixar de passar pelo RPC sem que ninguém perceba que a guarda saiu
 * junto.
 *
 * ⚠️ Esta prosa NÃO escreve o nome daquela função seguido de parêntese, e é de
 * propósito: o gate casa o texto INCLUINDO comentários, então escrevê-lo aqui
 * satisfaria o gate sozinho e apagar a chamada de verdade ficaria verde.
 *
 * ## `aviso_numero_de_cliente` é uma PERGUNTA, não uma recusa
 *
 * O número de aviso vira INTERNO: tudo o que chegar dele deixa de virar
 * contato, conversa e atendimento. Se ele já é um cliente desta organização,
 * confirmar significa que as mensagens dessa pessoa param de chegar ao CRM.
 * O RPC recusa uma vez; a tela mostra a consequência e reenvia com
 * `confirma_contato: true`. Isso é irreversível o bastante para custar um
 * clique deliberado.
 *
 * ## i18n
 *
 * `PASTAS_IGNORADAS` do gate de espanhol inclui `api`, então as frases desta
 * rota NÃO são cobradas por catraca nenhuma. Elas entram no dicionário por
 * DISCIPLINA — a ausência de gate aqui não é aprovação.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { lerEstadoDaTelaDeAviso } from "@/lib/escalacao/tela-do-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * O corpo. `strict()` porque um campo a mais aqui é sempre engano: quem manda
 * `ligado` junto de `on` está falando com uma versão da API que não existe.
 *
 * `telefone` valida a MESMA forma do CHECK `config_aviso_de_caso_e164`. A
 * duplicação está declarada: sem ela, o erro só apareceria como
 * `aviso_de_caso_telefone_invalido` cru vindo do Postgres.
 */
const corpo = z
  .object({
    channel_session_id: z.string().uuid(),
    telefone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/),
    rotulo: z.string().trim().max(60).nullable().optional(),
    ligado: z.boolean(),
    sem_link: z.boolean().optional(),
    repetir_lembretes_whatsapp: z.boolean().default(false),
    minutos_lembrete_equipe: z
      .array(z.number().int().min(1).max(1440))
      .min(1)
      .max(10)
      .default([3, 6, 9])
      .refine((valores) =>
        valores.every((valor, indice) => indice === 0 || valores[indice - 1]! < valor),
      ),
    /** `true` = "eu sei que este número é um cliente meu, e quero mesmo assim". */
    confirma_contato: z.boolean().optional(),
  })
  .strict();

/**
 * O que cada exceção do RPC vira no wire.
 *
 * Tabela e não uma cadeia de `if`: os seis nomes são contrato do banco (estão
 * escritos no corpo da função da migration 0292), e um `includes` solto
 * espalhado pelo handler divergiria deles em silêncio.
 */
const RECUSAS_DO_RPC = {
  aviso_de_caso_forbidden: {
    code: "forbidden_role",
    status: 403 as const,
    frase: "Só quem administra a conta pode configurar o aviso no WhatsApp.",
  },
  aviso_de_caso_mfa_required: {
    code: "mfa_required",
    status: 403 as const,
    frase: "Confirme sua identidade para mudar o aviso no WhatsApp.",
  },
  aviso_de_caso_telefone_invalido: {
    code: "validation_failed",
    status: 422 as const,
    frase: "Esse número não é válido. Use o código do país, por exemplo +55 31 99999-8888.",
  },
  aviso_de_caso_canal_invalido: {
    code: "aviso_canal_invalido",
    status: 422 as const,
    frase: "A conexão escolhida não existe mais nesta conta. Escolha outra.",
  },
  aviso_de_caso_numero_da_propria_org: {
    code: "aviso_numero_da_propria_org",
    status: 422 as const,
    frase:
      "Esse é um dos números conectados da sua conta. Ele não pode receber os avisos, senão um responde ao outro sem parar.",
  },
  aviso_de_caso_numero_de_cliente: {
    code: "aviso_numero_de_cliente",
    status: 422 as const,
    frase:
      "Esse número já é de um cliente seu. Se você continuar, as mensagens dele param de chegar ao CRM.",
  },
} as const;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "config_aviso_de_caso" });
  if (!authz.ok) return authz.response;

  const db = await createClient();
  const estado = await lerEstadoDaTelaDeAviso({
    db,
    admin: createAdminClient(),
    organizationId: authz.org.orgId,
    urlPublica: env.NEXT_PUBLIC_APP_URL,
  });
  return ok(estado, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  // PRIMEIRO passo do handler. Um admin de plataforma em acompanhamento
  // somente-leitura não muda para onde os avisos do cliente vão.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "config_aviso_de_caso" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body inválido."), 400, { requestId });
  }
  const parsed = corpo.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Body inválido."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const dados = parsed.data;

  // Client de SESSÃO: o RPC é `security definer` e lê `auth.uid()` para saber
  // QUEM está escrevendo. Chamá-lo pelo admin faria `auth.uid()` ser nulo, e a
  // primeira guarda do corpo da função recusaria — com o código de quem não
  // tem permissão, sobre um admin que tem.
  const db = await createClient();
  const { data, error } = await db.rpc(
    "fn_definir_aviso_de_caso_repeticao" as never,
    {
      p_org: authz.org.orgId,
      p_channel: dados.channel_session_id,
      p_telefone: dados.telefone,
      p_rotulo: dados.rotulo ?? null,
      p_ligado: dados.ligado,
      p_confirma_contato: dados.confirma_contato ?? false,
      p_sem_link: dados.sem_link ?? false,
      p_repetir_lembretes_whatsapp: dados.repetir_lembretes_whatsapp,
      p_minutos_lembrete_equipe: dados.minutos_lembrete_equipe,
    } as never,
  );

  if (error) {
    const recusa = Object.entries(RECUSAS_DO_RPC).find(([nome]) =>
      (error.message ?? "").includes(nome),
    )?.[1];
    if (recusa) return fail(recusa.code, t(recusa.frase), recusa.status, { requestId });
    return fail("internal_error", t("Não foi possível salvar o aviso."), 500, { requestId });
  }

  const resultado = (data ?? {}) as { trocou_numero?: boolean; antes_ligado?: boolean };

  // ⚠️ O número entra MASCARADO. `api_audit_log` é append-only — sem UPDATE nem
  // DELETE para papel nenhum, nem para `service_role` —, então o que entra ali
  // NÃO sai pela cascata de LGPD. Um telefone de funcionário gravado inteiro
  // fica para sempre. Os quatro últimos dígitos respondem "trocaram o número?"
  // sem guardar a pessoa.
  void audit({
    action: "ai.case_alert_settings_changed",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "config_aviso_de_caso",
    resourceId: authz.org.orgId,
    metadata: {
      destino_mascarado: mascara(dados.telefone),
      ...(dados.sem_link === undefined ? {} : { sem_link: dados.sem_link }),
      repetir_lembretes_whatsapp: dados.repetir_lembretes_whatsapp,
      minutos_lembrete_equipe: dados.minutos_lembrete_equipe,
      trocou_numero: Boolean(resultado.trocou_numero),
      antes_ligado: Boolean(resultado.antes_ligado),
      depois_ligado: dados.ligado,
      canal: dados.channel_session_id,
      confirmou_contato: dados.confirma_contato ?? false,
    },
  });

  // A resposta é o ESTADO inteiro recalculado, e não um `{ ok: true }`: salvar
  // pode mudar os alertas da tela (trocar de conexão muda o aquecimento, ligar
  // muda o que a lista diz), e um `{ ok: true }` obrigaria a tela a adivinhar
  // ou a fazer um GET logo atrás.
  const estado = await lerEstadoDaTelaDeAviso({
    db,
    admin: createAdminClient(),
    organizationId: authz.org.orgId,
    urlPublica: env.NEXT_PUBLIC_APP_URL,
  });
  return ok(estado, { requestId });
}
