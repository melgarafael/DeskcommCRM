"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import type { RecusaDeEscritaDeAdmin } from "@/lib/auth/recusa-de-escrita-de-admin";
import {
  entradaDeDestinoValida,
  estadoDosDestinosInternos,
  gravarDestinosInternos,
} from "@/lib/automation/destinos-internos-autorizados";

export type UpdateDestinosInternosResult =
  | { ok: true }
  | { ok: false; error: "invalid_input" | "write_failed"; invalidas?: readonly string[] }
  | RecusaDeEscritaDeAdmin;

/**
 * A lista de endereços internos que ESTA INSTALAÇÃO pode alcançar — decisão
 * 22-d, issue #1004.
 *
 * ── Por que `is_platform_admin`, e não `admin` do tenant ────────────────────
 *
 * O objeto é a rede da máquina, não a configuração de uma empresa. Se o admin
 * de um tenant pudesse escrever aqui, a regra 2 da decisão ("a empresa continua
 * sem poder apontar para dentro sozinha") viraria letra morta por um caminho
 * mais curto que o que ela fecha. Mesmo gate de `updateSignupMode.ts`, que este
 * arquivo espelha.
 *
 * ── Por que a validação é aqui, e não só no módulo ──────────────────────────
 *
 * A leitura já ignora entrada fora do formato, e ignorar é recusar — então o
 * banco sujo não abre a rede. O que ele faz é pior de outro jeito: a tela
 * mostraria `10.1.0.0/artes` salvo e em vigor, e o operador concluiria que
 * autorizou algo. Recusar na escrita é o que faz a tela dizer a verdade.
 *
 * ── Por que auditar ────────────────────────────────────────────────────────
 *
 * "Desde quando este servidor fala com a rede interna?" só tem resposta aqui:
 * a mudança não deixa rastro em nenhuma outra tabela, e não há consumidor de
 * event_log para o tipo (evento sem consumer é o anti-pattern nº 3). A trilha
 * tem consumidor real, que é `/admin/audit`. A linha carrega a lista ANTERIOR
 * e a nova: sem as duas, ela responde "quem mexeu" e não "o que mudou".
 */
const entradaSchema = z.object({
  /** Uma entrada por linha, como a pessoa digita. Vírgula também separa. */
  destinos: z.string().max(10_000),
});

export async function updateDestinosInternos(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdateDestinosInternosResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  const itens = parsed.data.destinos
    .split(/[\n,]/)
    .map((e) => e.trim())
    .filter((e) => e !== "");

  const invalidas = itens.filter((e) => !entradaDeDestinoValida(e));
  if (invalidas.length > 0) return { ok: false, error: "invalid_input", invalidas };

  // Duplicata não é erro de quem digita — é ruído. Tirar aqui mantém a lista
  // gravada igual à lista em vigor, que é o que a tela promete mostrar.
  const lista = [...new Set(itens)];

  const anterior = await estadoDosDestinosInternos();

  if (!(await gravarDestinosInternos(lista, user.id))) {
    return { ok: false, error: "write_failed" };
  }

  const hdrs = await headers();
  await audit({
    action: "platform.internal_destinations_updated",
    actorUserId: user.id,
    resourceType: "platform_settings",
    metadata: {
      de: anterior.lista,
      para: lista,
      // Sem isto, a primeira gravação de toda instalação parece uma troca
      // (".env" → "banco") sem dizer que o `.env` era quem mandava até ali.
      vinha_do_env: anterior.vemDoPiso,
    },
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/destinos-internos");
  return { ok: true };
}
