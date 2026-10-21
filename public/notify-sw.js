/*
 * O único service worker do produto, escrito à mão (ADR-0006, D3).
 *
 * Faz três coisas e nada além:
 *  1. todo push recebido vira notificação — o Safari/iOS revoga a inscrição de
 *     quem recebe push sem mostrar nada;
 *  2. o clique na notificação leva para a janela do app, no destino do aviso;
 *  3. uma NAVEGAÇÃO que falha por rede recebe uma página neutra (D4).
 *
 * Não guarda nada: nenhum Cache Storage, nenhuma resposta de API, de HTML
 * autenticado ou de mídia. Toda requisição que não é navegação passa direto.
 */

/* Os avisos que a própria página também mostra quando está aberta (mesma tag). */
const PREFIXOS_COM_AVISO_LOCAL = ["msg", "lead-assigned", "lead-won", "lead-lost", "mention"];
const PADRAO = { title: "Nova mensagem", body: "", tag: "msg", href: "/app/inbox", icon: "" };

function janelaDoApp(cliente) {
  try {
    const caminho = new URL(cliente.url).pathname;
    return caminho === "/app" || caminho.startsWith("/app/");
  } catch {
    return false;
  }
}

/*
 * A janela em foco está lendo esta conversa? A página não avisa nesse caso
 * (`lib/notifications/policy.ts`), e o push também não deve ficar na bandeja.
 * ponytail: lê só a URL do inbox (`/app/inbox?id=`); a conversa aberta no
 * painel flutuante não aparece na URL e segue avisando. Se pesar, a página
 * responde ao SW por postMessage qual conversa tem aberta.
 */
function lendoAConversa(cliente, conversa) {
  if (!cliente.focused) return false;
  try {
    const url = new URL(cliente.url);
    return url.pathname === "/app/inbox" && url.searchParams.get("id") === conversa;
  } catch {
    return false;
  }
}

/* Para onde vai o clique: a janela do app em foco, senão a visível, senão qualquer uma. */
function escolherJanela(clientes) {
  const doApp = clientes.filter(janelaDoApp);
  return (
    doApp.find((c) => c.focused) ||
    doApp.find((c) => c.visibilityState === "visible") ||
    doApp[0] ||
    clientes[0]
  );
}

// Sem rota estática (`addRoutes`): num Chrome que tem a API mas não conhece a
// condição `not`, ela podia mandar a navegação direto à rede e apagar a página
// offline sem aviso. O `fetch` abaixo já deixa passar o que não é navegação.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A navegação sai do próprio navegador enquanto o SW acorda: mesma
      // semântica de cookie de quem não tem SW, e sem esperar o SW iniciar.
      try {
        if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      } catch {
        // sem preload, o fetch abaixo busca a página
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = PADRAO;
      try {
        if (event.data) data = { ...PADRAO, ...event.data.json() };
      } catch {
        // payload não-JSON: aviso padrão
      }
      const titulo = (typeof data.title === "string" && data.title) || PADRAO.title;
      const corpo = typeof data.body === "string" ? data.body : "";
      // Tag vazia com `renotify` lança — e aí nenhuma notificação aparece.
      const tag = (typeof data.tag === "string" && data.tag) || PADRAO.tag;
      // Com o app à vista, a página já mostrou o aviso de mesma tag e tocou o
      // som: esta substitui aquela, calada. Fora disso, toca.
      let aVista = false;
      let lendo = false;
      if (PREFIXOS_COM_AVISO_LOCAL.includes(tag.split(":")[0])) {
        try {
          const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          aVista = clientes.some((c) => c.visibilityState === "visible" && janelaDoApp(c));
          const [prefixo, conversa] = tag.split(":");
          lendo = prefixo === "msg" && Boolean(conversa) && clientes.some((c) => lendoAConversa(c, conversa));
        } catch {
          aVista = false;
        }
      }
      try {
        await self.registration.showNotification(titulo, {
          body: corpo,
          tag,
          icon: data.icon || undefined,
          silent: aVista,
          renotify: !aVista,
          data: { href: data.href || PADRAO.href },
        });
      } catch {
        await self.registration.showNotification(titulo, { body: corpo });
      }
      // Mostrar e fechar em seguida: o push continua virando notificação (regra
      // do Safari/iOS), mas não fica na bandeja de quem está lendo a conversa.
      if (lendo) {
        try {
          const abertas = await self.registration.getNotifications({ tag });
          for (const n of abertas) n.close();
        } catch {
          // sem getNotifications, o aviso calado fica na bandeja
        }
      }
    })(),
  );
});

/*
 * Clique na notificação: a janela do app vai para o destino; sem janela, abre
 * uma. Aviso sem destino (ex.: "Alertas ligados") só traz a janela à frente,
 * sem tirar a pessoa da tela em que ela está.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const origem = self.location.origin;
  const href = event.notification.data && event.notification.data.href;
  let url = href ? origem + PADRAO.href : null;
  try {
    if (href) {
      const destino = new URL(href, origem);
      if (destino.origin === origem) url = destino.href;
    }
  } catch {
    // href inválido: fica o inbox
  }
  event.waitUntil(
    (async () => {
      const clientes = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const alvo = escolherJanela(clientes);
      if (!alvo) return self.clients.openWindow ? self.clients.openWindow(url || origem + "/app") : undefined;
      try {
        await alvo.focus();
      } catch {
        // foco recusado: ainda dá para navegar
      }
      if (!url) return undefined;
      try {
        await alvo.navigate(url);
      } catch {
        // janela não controlada por este SW: a página navega sozinha
        // (`lib/notifications/notify_open.ts`)
        alvo.postMessage({ type: "notify-open", href: url });
      }
      return undefined;
    })(),
  );
});

/*
 * Página offline (D4). Textos aqui dentro porque o dicionário do app não
 * alcança o SW. Nenhum nome de marca, contato ou mensagem.
 */
const TEXTOS_OFFLINE = {
  pt: {
    titulo: "Sem conexão",
    texto: "Não foi possível abrir agora. Confira a internet e toque em Tentar de novo.",
    botao: "Tentar de novo",
  },
  es: {
    titulo: "Sin conexión",
    texto: "No fue posible abrir ahora. Revisa la conexión a internet y toca Intentar de nuevo.",
    botao: "Intentar de nuevo",
  },
  en: {
    titulo: "No connection",
    texto: "This page couldn't open right now. Check your internet and tap Try again.",
    botao: "Try again",
  },
};

function paginaOffline() {
  const pedida = String((self.navigator && self.navigator.language) || "").slice(0, 2).toLowerCase();
  const lingua = TEXTOS_OFFLINE[pedida] ? pedida : "pt";
  const t = TEXTOS_OFFLINE[lingua];
  const html = `<!doctype html>
<html lang="${lingua}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${t.titulo}</title>
<style>
  :root { color-scheme: light dark; --fundo: #ffffff; --texto: #1f2937; --suave: #4b5563; --botao: #1f2937; --botao-texto: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fundo: #111827; --texto: #f3f4f6; --suave: #d1d5db; --botao: #f3f4f6; --botao-texto: #111827; } }
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center; background: var(--fundo); color: var(--texto); font-family: system-ui, -apple-system, sans-serif; }
  main { max-width: 22rem; padding: 1.5rem 16px; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: var(--suave); line-height: 1.5; margin: 0 0 1.5rem; }
  button { min-height: 44px; padding: 0 1.5rem; border: 0; border-radius: 0.5rem; background: var(--botao); color: var(--botao-texto); font: inherit; font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>${t.titulo}</h1>
<p>${t.texto}</p>
<button type="button" onclick="location.reload()">${t.botao}</button>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(req));
      } catch {
        // Só falha de REDE rejeita: 3xx, 4xx e 5xx resolvem e passam intactos.
        return paginaOffline();
      }
    })(),
  );
});
