# Cada aviso do celular liga e desliga sozinho (PR #4310, de @mbiero)

**Tipo:** REGERADA. As duas capturas saem de `tests/e2e/notificacoes-cada-tipo-no-push.spec.ts`
a cada execução (função `captura`), pela tela **Configurações › Notificações**, com a permissão e o
`PushManager` do navegador dublados (o Chromium headless responde `denied` e não há FCM no runner).
A tela, a rota `/api/v1/notifications/push`, a sessão e o banco são de verdade.

| Arquivo | O que prova |
|---|---|
| `01-antes.png` | A tela antes de mexer: todo tipo com o seu interruptor de Push ligado, e os dois tipos novos ("A IA passou uma conversa para a equipe" e "Negócio entrou numa etapa que avisa") só com Push — dentro do app eles são a Central de avisos. |
| `02-so-lead-atribuido.png` | Depois de desligar "Nova mensagem", a passagem da IA e a etapa: "Lead atribuído a você" segue ligado e clicável, e a frase diz que cada aviso liga e desliga sozinho. O spec confere, junto, que nenhum DELETE da inscrição saiu. |

**Para reproduzir:** `pnpm test:e2e tests/e2e/notificacoes-cada-tipo-no-push.spec.ts` (mesmos
pré-requisitos de `notificacoes-diz-o-que-falta.spec.ts`).

**Não medido por estas capturas:** o aviso chegando de verdade num celular, e o servidor deixando de
mandar o tipo calado. O segundo é coberto por `lib/notifications/web_push.test.ts`
("o aparelho escolhe os tipos de aviso").
