"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { loadAuthUser } from "@/lib/auth/server";
import {
  CHAVE_TEMA_DA_PLATAFORMA,
  conferirTemaDaPlataforma,
  invalidarTemaDaPlataforma,
} from "@/lib/extensions/tema-da-plataforma";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { gravarPelaTela, voltarAoAmbiente } from "@/lib/instalacao/config";

export type UpdatePlatformThemeResult = { ok: true } | { ok: false; error: string };

/**
 * Grava (ou apaga) o TEMA DA PLATAFORMA (#3790).
 *
 * ── O que entra, e o que NÃO entra ─────────────────────────────────────────
 *
 * Entra o **id da instalação da extensão** — não o CSS (DIRC: calcular). Quem
 * atualizar a extensão, desfizer a atualização ou a remover não precisa voltar
 * aqui: a leitura do layout relê o manifesto vigente e, sem instalação válida,
 * o tema simplesmente deixa de ser aplicado.
 *
 * ── `null` = "Nenhum", e "Nenhum" APAGA a linha ────────────────────────────
 *
 * Não grava string vazia: `voltarAoAmbiente` deleta a linha de
 * `platform_config`, e o estado volta a ser "ninguém escolheu" — indistinguível
 * de uma instalação que nunca usou o recurso. É o que mantém a promessa "sem
 * escolha, nada muda".
 *
 * ── A lista da tela é sugestão; o banco é a régua ──────────────────────────
 *
 * A tela oferece só instalações que declaram tema, mas o payload é do cliente:
 * a ação confere no BANCO que a instalação existe, não foi removida e traz um
 * tema válido (`conferirTemaDaPlataforma`). As guardas de papel são as mesmas
 * do CSS personalizado — escrita de admin de plataforma, sem dívida de MFA e
 * fora do acompanhamento administrativo —, e a auditoria usa o mesmo evento
 * (`platform_branding.updated`), porque a superfície é a mesma.
 */
export async function updatePlatformTheme(input: unknown): Promise<UpdatePlatformThemeResult> {
  // Permissão ANTES de olhar a entrada: quem não pode gravar recebe a recusa,
  // nunca as mensagens do validador.
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) {
    return {
      ok: false,
      error:
        escrita.error === "mfa_required"
          ? "Confirme a verificação em duas etapas."
          : "Esta ação exige acesso completo à instalação.",
    };
  }
  const { user } = escrita.ctx;
  const usuarioAtual = await loadAuthUser();
  if (usuarioAtual?.support) {
    return { ok: false, error: "Saia do acompanhamento administrativo antes de mudar a marca." };
  }

  // `null` é escolha legítima ("Nenhum") e APAGA a linha; por isso `undefined`
  // NÃO cai em "Nenhum": um payload que nem trouxe o campo não pode desligar o
  // tema de uma instalação. `undefined` é payload inválido, e não vira consulta.
  const parsed = z.union([z.string().min(1).max(200), z.null()]).safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Escolha um tema da lista de extensões instaladas." };
  const escolhido = parsed.data;

  let paleta: string | null = null;
  if (escolhido !== null) {
    const conferencia = await conferirTemaDaPlataforma(escolhido);
    if (!conferencia.ok) {
      if (conferencia.motivo === "banco_indisponivel") {
        return { ok: false, error: "Não foi possível conferir a extensão agora. Tente de novo." };
      }
      return {
        ok: false,
        error:
          conferencia.motivo === "nao_instalada"
            ? "Essa extensão não está mais instalada nesta instalação."
            : "A extensão escolhida não oferece um tema válido.",
      };
    }
    paleta = conferencia.tema.palette;
  }

  const resultado =
    escolhido === null
      ? await voltarAoAmbiente(CHAVE_TEMA_DA_PLATAFORMA)
      : await gravarPelaTela(CHAVE_TEMA_DA_PLATAFORMA, escolhido, {
          ehSegredo: false,
          ator: user.id,
        });
  if (!resultado.ok) {
    return { ok: false, error: "Não foi possível gravar o tema no banco da instalação." };
  }

  invalidarTemaDaPlataforma();
  const hdrs = await headers();
  await audit({
    action: "platform_branding.updated",
    actorUserId: user.id,
    resourceType: "platform_branding",
    resourceId: null,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
    actingAsPlatformAdmin: true,
    metadata: {
      fields_changed: ["platform_theme"],
      // O id da INSTALAÇÃO é o que a operação grava; a paleta é o que a tela
      // humana consegue conferir depois. Nenhum dos dois é dado de cliente.
      platform_theme: escolhido === null ? "nenhum" : escolhido,
      platform_theme_palette: paleta,
    },
  });

  return { ok: true };
}
