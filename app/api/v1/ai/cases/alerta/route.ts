/**
 * GET/PUT/DELETE /api/v1/ai/cases/alerta — a configuração do aviso de caso no
 * WhatsApp da equipe (migration 0292).
 *
 * ## DELETE: remover o destinatário, sem exigir um número substituto (issue #3338)
 *
 * O `PUT` exige um telefone E.164 válido: é a forma que o banco aceita, e não
 * há como "salvar sem número". Sem uma ação de remoção, quem quisesse LIBERAR o
 * número antigo — para as mensagens dele voltarem a virar atendimento — tinha
 * dois contornos, e os dois são mentira: apagar o campo (a tela desabilita
 * Salvar) ou cadastrar um número inexistente no lugar. O `DELETE` é essa ação.
 *
 * ## Remover é a LINHA sair, não o telefone virar nulo
 *
 * `telefone_destino` é `not null` com CHECK E.164 (migration 0292): não existe
 * "configuração sem número" no schema, e inventar um valor vazio ou sentinela
 * seria o mesmo contorno, agora gravado. Apagar a linha é o que sobra — e é
 * exatamente o que a regra de `lib/escalacao/numero-interno-de-aviso.ts` lê:
 * sem `telefone_destino` e sem `destino_jid`, não há destino a reconhecer como
 * interno, e o número volta à ingestão normal. O `destino_jid` vai junto porque
 * ele é a OUTRA porta do mesmo corte (o destinatário em modo privacidade).
 *
 * ## Isto NÃO é pausar, e pausar continua sendo pausar
 *
 * `ligado: false` PRESERVA o telefone e, por decisão escrita no cabeçalho de
 * `numero-interno-de-aviso.ts`, o número segue interno: as mensagens da equipe
 * continuam sendo cortadas na ingestão. É o comportamento pedido pela issue e
 * ele não muda aqui. O que este handler faz é remover a configuração inteira —
 * e é a única das duas ações que devolve o número ao Inbox. Por isso ele não
 * escreve `ligado` em lugar nenhum: quem pausa é o switch, quem remove é este
 * botão.
 *
 * ## As guardas são as mesmas, MENOS as que só valem para uma escrita de número
 *
 * `requireSupportWrite()`, papel `admin` e a dívida de MFA (`mfaEmDivida`, a
 * mesma régua de `fn_session_mfa_proven` que o RPC cobra). O resto do corpo do
 * RPC — E.164, canal da organização, "é um número da própria org", "já é um
 * cliente seu" — existe para validar o número que ENTRA. Não há número entrando
 * aqui: a escrita é o DELETE de uma linha cujo `organization_id` é o da sessão,
 * e é o `eq` que faz a fronteira entre tenants.
 *
 * ⚠️ `createAdminClient()` e não o client de sessão: a tabela é `revoke all`
 * para `authenticated` — o papel autorizado é o do ROUTE, conferido acima. A
 * alternativa seria um RPC novo, e isso é migration: a remoção não precisa de
 * schema novo.
 *
 * ## A escrita do `PUT` é do RPC — e a rota não escreve uma linha na tabela
 *
 * (`DELETE` é a exceção, e está declarada acima: não existe RPC de remoção.)
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
import { mfaEmDivida } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { mascara } from "@/lib/escalacao/aviso-ao-suporte";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
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
    resposta_whatsapp_habilitada: z.boolean().default(false),
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
    "fn_definir_aviso_de_caso" as never,
    {
      p_org: authz.org.orgId,
      p_channel: dados.channel_session_id,
      p_telefone: dados.telefone,
      p_rotulo: dados.rotulo ?? null,
      p_ligado: dados.ligado,
      p_confirma_contato: dados.confirma_contato ?? false,
      p_resposta_whatsapp_habilitada: dados.resposta_whatsapp_habilitada,
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
      trocou_numero: Boolean(resultado.trocou_numero),
      antes_ligado: Boolean(resultado.antes_ligado),
      depois_ligado: dados.ligado,
      resposta_whatsapp_habilitada: dados.resposta_whatsapp_habilitada,
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

/**
 * `DELETE` — a REMOÇÃO do destinatário. Ver o cabeçalho do arquivo.
 *
 * Devolve o estado recalculado, como o `PUT`: quem clica em "remover" precisa
 * ver a tela sem configuração, e não um `{ ok: true }` para a tela adivinhar.
 */
export async function DELETE(_req: NextRequest): Promise<Response> {
  // PRIMEIRO passo, como no PUT. O acompanhamento somente-leitura não remove a
  // configuração de ninguém, e esta guarda é o que fecha a porta de suporte do
  // client de serviço usado logo abaixo.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "config_aviso_de_caso" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  // A MESMA régua que o RPC cobra (`fn_session_mfa_proven`, via `mfaEmDivida`):
  // quem tem fator cadastrado prova o código também para REMOVER. Sem isto a
  // remoção seria a porta dos fundos da configuração — a ação que desfaz o que
  // só uma sessão provada podia fazer.
  if (await mfaEmDivida()) {
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });
  }

  // `select` depois do `delete`: sem ele o PostgREST não devolve a linha
  // removida, e o rastro de auditoria perderia o número mascarado — que é o que
  // responde "quem removeu qual destinatário". O `eq` do `organization_id` é a
  // fronteira entre tenants aqui: a tabela é `revoke all` para `authenticated`,
  // então quem escreve é este client de serviço, com o papel já conferido.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("config_aviso_de_caso" as never)
    .delete()
    .eq("organization_id" as never, authz.org.orgId)
    .select("telefone_destino, ligado, resposta_whatsapp_habilitada");

  if (error) {
    return fail("internal_error", t("Não foi possível remover o destinatário."), 500, {
      requestId,
    });
  }

  const removida =
    (
      (data ?? []) as Array<{
        telefone_destino?: string | null;
        ligado?: boolean | null;
        resposta_whatsapp_habilitada?: boolean | null;
      }>
    )[0] ?? null;

  // ⚠️ O memo de 30 s da regra ainda guarda a configuração ANTIGA, e é ele que
  // responde ao ingestor a cada mensagem recebida: sem esta linha, o número
  // removido continuaria sendo cortado até o memo expirar. Vale para ESTE
  // processo; nos outros (o worker que recebe o webhook), quem responde é o TTL.
  limparCacheDoNumeroInterno();

  // Linha nenhuma removida não é mutação, e sem mutação não há o que auditar —
  // a mesma régua da inscrição de push que já não existia. Chega aqui com a
  // tela aberta em duas abas, e a resposta certa é o estado, não um erro.
  if (removida) {
    void audit({
      action: "ai.case_alert_settings_removed",
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      resourceType: "config_aviso_de_caso",
      resourceId: authz.org.orgId,
      metadata: {
        // Mascarado pela MESMA razão do PUT: `api_audit_log` é append-only e a
        // cascata de LGPD não o alcança.
        destino_mascarado: mascara(removida.telefone_destino ?? ""),
        // A decisão de pausa COMO ELA ESTAVA, e só isso: este handler não
        // escreve `ligado` em lugar nenhum, então este campo é o registro do
        // que havia — não um valor que a remoção tenha passado a valer.
        antes_ligado: Boolean(removida.ligado),
        resposta_whatsapp_habilitada: Boolean(removida.resposta_whatsapp_habilitada),
      },
    });
  }

  const db = await createClient();
  const estado = await lerEstadoDaTelaDeAviso({
    db,
    admin,
    organizationId: authz.org.orgId,
    urlPublica: env.NEXT_PUBLIC_APP_URL,
  });
  return ok(estado, { requestId });
}
