import { Fragment } from "react";

import { partesComLinks } from "@/lib/inbox/links-no-texto";

/**
 * O corpo do texto com os endereços como âncora (#4576).
 *
 * Quem monta o `<a>` é o React, a partir dos pedaços de `partesComLinks` —
 * não há `dangerouslySetInnerHTML` e o texto do contato nunca vira marcação.
 * `target`/`rel` são fixos aqui: o link sai da conversa para outra aba e a
 * página de destino não recebe `window.opener` nem o `Referer` da conversa.
 *
 * As classes são só do link (sublinhado e quebra forçada). O espaçamento do
 * corpo continua sendo o do `<p>` que envolve este componente
 * (`whitespace-pre-wrap`), que é herdado pelos pedaços de texto.
 */
export function TextoComLinks({ texto }: { texto: string }) {
  return (
    <>
      {partesComLinks(texto).map((parte, i) =>
        parte.href ? (
          <a
            key={i}
            href={parte.href}
            target="_blank"
            rel="noopener noreferrer"
            className="wrap-anywhere underline underline-offset-2"
          >
            {parte.texto}
          </a>
        ) : (
          <Fragment key={i}>{parte.texto}</Fragment>
        ),
      )}
    </>
  );
}
