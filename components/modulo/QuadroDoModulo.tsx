"use client";

/**
 * O QUADRO DO MÓDULO CONECTADO: a tela dele, num iframe de OUTRA origem (Spec 33, F4, tarefa 3).
 *
 * O CRM é dono da moldura e o módulo é dono do conteúdo. O módulo nunca recebe cookie, token ou
 * endereço livre do CRM. Tudo o que ele pede passa pela lista fechada de 6 mensagens de
 * `lib/modulo/ponte.ts`, e só vale mensagem que vem da ORIGEM do serviço E da JANELA deste iframe.
 *
 * Regras que este arquivo cumpre (cada uma tem teste em `QuadroDoModulo.test.tsx`):
 *  - o `postMessage` do CRM usa SEMPRE `targetOrigin = serviceOrigin`, nunca "*";
 *  - `module:navigate` só resolve um id da lista de telas que a PESSOA vê (catálogo de navegação,
 *    filtrado como o menu); qualquer outra coisa é ignorada em silêncio;
 *  - no máximo 1 pedido de JWT a cada 30 s (o seguinte recebe `host:error rate_limited`);
 *  - sem `module:ready` em 10 s aparece um aviso em português simples e o resto da página segue;
 *  - a URL do iframe leva só identificadores (`organization`, `installation`): nenhum JWT, token ou
 *    segredo. O JWT de contexto só viaja por `postMessage`, para a origem conferida.
 *
 * `allow-same-origin` no sandbox refere-se à origem DO MÓDULO, que nunca é a do CRM
 * (`lib/extensions/modulos-na-tela.ts` descarta o módulo cuja origem é a do CRM).
 */
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestExtensionApi } from "@/components/extensions/api-client";
import { useAuth } from "@/hooks/auth/AuthProvider";
import type { ModuloNaTela } from "@/lib/extensions/modulos-na-tela";
import { useIdioma, useT } from "@/lib/i18n/IdiomaProvider";
import {
  lerMensagemDoModulo,
  mensagemParaOModulo,
  type MensagemParaOModulo,
} from "@/lib/modulo/ponte";
import { permitidos } from "@/lib/navigation/interface";
import { HEADER_ORG_DA_ABA } from "@/lib/auth/org-da-aba";
import { useTheme } from "@/lib/theme";

/** Sem `module:ready` neste prazo, o aviso aparece. */
export const PRAZO_DO_PRONTO_MS = 10_000;
/** No máximo um pedido de JWT por esta janela. */
export const JANELA_DO_JWT_MS = 30_000;

const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin";

/**
 * O id que o módulo usa para pedir uma tela do CRM: o `href` do catálogo sem o prefixo `/app/` e com
 * `/` virando `-` (`/app/settings/tenant` → `settings-tenant`). Nunca é um endereço: o módulo só
 * escolhe um nome, e o CRM resolve (ou ignora).
 */
export function idDeNavegacao(href: string): string | null {
  if (!href.startsWith("/app/")) return null;
  const id = href.slice("/app/".length).replace(/\//g, "-");
  return /^[a-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** Endereço do iframe: identificadores apenas, nada com poder. */
export function enderecoDoQuadro(
  serviceOrigin: string,
  organizationId: string,
  installationId: string,
): string {
  const url = new URL("/embed", serviceOrigin);
  url.searchParams.set("organization", organizationId);
  url.searchParams.set("installation", installationId);
  return url.toString();
}

type CodigoDeErro = Extract<MensagemParaOModulo, { type: "host:error" }>["code"];

/** Traduz a resposta da rota de contexto para o código fechado de `host:error`. */
function codigoDoErroDaRota(status: number): CodigoDeErro {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403 || status === 404 || status === 409) return "not_allowed";
  return "jwt_unavailable";
}

export function QuadroDoModulo({ modulo }: { modulo: ModuloNaTela }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const idioma = useIdioma();
  const { resolvedTheme } = useTheme();
  const { user, activeOrg } = useAuth();

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const prontoRef = useRef(false);
  const ultimoPedidoDeJwtRef = useRef<number | null>(null);
  const vivoRef = useRef(true);
  const [semResposta, setSemResposta] = useState(false);

  const organizationId = activeOrg?.orgId ?? "";
  const role = activeOrg?.role ?? null;
  const platform = Boolean(user.is_platform_admin && !user.support);
  const modulosLigados = activeOrg?.modulos_ligados;
  const capacidadesLigadas = activeOrg?.capacidades_ligadas;
  const nomeDaMarca = (activeOrg?.marca?.nome ?? activeOrg?.name ?? "").slice(0, 80);

  const src = useMemo(
    () =>
      organizationId ? enderecoDoQuadro(modulo.serviceOrigin, organizationId, modulo.installationId) : null,
    [modulo.serviceOrigin, modulo.installationId, organizationId],
  );

  // Telas que ESTA pessoa vê, as mesmas do menu (papel, módulos e capacidades ligados).
  const destinos = useMemo(() => {
    const mapa = new Map<string, string>();
    const repetidos = new Set<string>();
    for (const d of permitidos(platform, role, modulosLigados, capacidadesLigadas)) {
      const id = idDeNavegacao(d.href);
      if (!id) continue;
      if (mapa.has(id)) repetidos.add(id);
      mapa.set(id, d.href);
    }
    for (const id of repetidos) mapa.delete(id); // id ambíguo: não resolve para ninguém
    return mapa;
  }, [platform, role, modulosLigados, capacidadesLigadas]);

  const contexto = useMemo<MensagemParaOModulo>(
    () => ({
      type: "host:context",
      path: pathname || "/",
      locale: idioma,
      theme: resolvedTheme,
      brand: { name: nomeDaMarca },
    }),
    [pathname, idioma, resolvedTheme, nomeDaMarca],
  );

  /** Envia ao módulo SEMPRE para a origem do serviço. Nunca lança. */
  const enviar = useCallback(
    (mensagem: MensagemParaOModulo) => {
      const janela = iframeRef.current?.contentWindow;
      if (!janela) return;
      try {
        janela.postMessage(mensagemParaOModulo(mensagem), modulo.serviceOrigin);
      } catch {
        // mensagem inválida ou grande demais: não sai, e o CRM segue
      }
    },
    [modulo.serviceOrigin],
  );

  const pedirJwt = useCallback(async () => {
    const agora = Date.now();
    const ultimo = ultimoPedidoDeJwtRef.current;
    if (ultimo !== null && agora - ultimo < JANELA_DO_JWT_MS) {
      enviar({ type: "host:error", code: "rate_limited" });
      return;
    }
    // Marca ANTES de esperar a rede: dois pedidos seguidos não furam a janela.
    ultimoPedidoDeJwtRef.current = agora;
    const resposta = await requestExtensionApi<{ jwt?: unknown; expires_at?: unknown }>(
      `/api/v1/extensions/${encodeURIComponent(modulo.installationId)}/contexto`,
      {
        method: "POST",
        headers: organizationId ? { [HEADER_ORG_DA_ABA]: organizationId } : {},
      },
    );
    if (!vivoRef.current) return;
    if (!resposta.ok) {
      enviar({ type: "host:error", code: codigoDoErroDaRota(resposta.status) });
      return;
    }
    const { jwt, expires_at } = resposta.data;
    if (typeof jwt !== "string" || typeof expires_at !== "string") {
      enviar({ type: "host:error", code: "context_invalid" });
      return;
    }
    enviar({ type: "host:jwt", jwt, expires_at });
  }, [enviar, modulo.installationId, organizationId]);

  // A conversa: só vale mensagem da origem do serviço E da janela deste iframe.
  useEffect(() => {
    function aoReceber(evento: MessageEvent) {
      const mensagem = lerMensagemDoModulo(
        { origin: evento.origin, source: evento.source, data: evento.data },
        { origin: modulo.serviceOrigin, janela: iframeRef.current?.contentWindow },
      );
      if (!mensagem) return;
      if (mensagem.type === "module:ready") {
        prontoRef.current = true;
        setSemResposta(false);
        enviar(contexto);
      } else if (mensagem.type === "module:request-jwt") {
        void pedirJwt();
      } else if (mensagem.type === "module:navigate") {
        const href = destinos.get(mensagem.destination);
        if (href) router.push(href as never);
      }
    }
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, [modulo.serviceOrigin, enviar, pedirJwt, destinos, router, contexto]);

  // Caminho, idioma ou tema mudaram: o módulo (já pronto) recebe o contexto novo.
  useEffect(() => {
    if (prontoRef.current) enviar(contexto);
  }, [contexto, enviar]);

  // Sem `module:ready` no prazo, o aviso aparece; o resto da página segue.
  useEffect(() => {
    prontoRef.current = false;
    ultimoPedidoDeJwtRef.current = null;
    setSemResposta(false);
    const timer = setTimeout(() => {
      if (!prontoRef.current) setSemResposta(true);
    }, PRAZO_DO_PRONTO_MS);
    return () => clearTimeout(timer);
  }, [src]);

  useEffect(() => {
    vivoRef.current = true;
    return () => {
      vivoRef.current = false;
    };
  }, []);

  if (!src) return null;

  return (
    <div className="flex h-full min-h-[70vh] w-full flex-col gap-3">
      {semResposta && (
        <div
          role="status"
          className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          <p className="font-medium">{t("O serviço deste módulo não respondeu")}</p>
          <p className="text-muted-foreground">
            {t("O resto do CRM continua funcionando. Tente de novo em instantes.")}
          </p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={modulo.titulo}
        src={src}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
        className="min-h-[70vh] w-full flex-1 rounded-md border border-border bg-background"
      />
    </div>
  );
}
