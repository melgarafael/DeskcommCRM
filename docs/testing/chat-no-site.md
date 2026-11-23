# Roteiro de prova pela tela — Chat no site (F2-A)

> Prova dirigida pelo navegador (Playwright), banco fresco do `supabase/baseline.sql`,
> variáveis opcionais ausentes, estado real de uma instalação nova. Cada caso mede o
> que a tela mostra, não o que o código afirma.

A spec é `tests/e2e/chat-no-site.spec.ts`. Está **escrita e NÃO executada ainda**:
o e2e só roda em PR para a main; a prova pela tela fica para o CI do PR ao mantenedor.

## Contexto

O módulo `canal_webchat` nasce desligado. Quem liga é o DONO DA INSTALAÇÃO em
`/admin/sistema` (não o admin da empresa). Só depois o admin da empresa entra em
Conexões › "Chat no site" para criar a conexão.

## Casos

| # | Caso | Expectativa | Spec |
|---|------|-------------|------|
| C1 | Módulo desligado → nenhuma diferença | Sem aba "Chat no site" em Conexões; `/chat/<chave>` e `/api/v1/webchat/*` respondem 404 | `tests/e2e/chat-no-site.spec.ts` "C1" |
| C2 | Dono liga o módulo; admin da empresa cria a conexão | A aba "Chat no site" aparece em Conexões; cadastrar o domínio do servidor de teste gera a chave `wck_...` | `tests/e2e/chat-no-site.spec.ts` "C2" |
| C3 | Servidor de teste serve a página com o código colado | A bolha aparece no canto da página; abrir a janela carrega `/chat/<chave>` | `tests/e2e/chat-no-site.spec.ts` "C3" |
| C4 | Visitante conversa | Aceitar o aviso de LGPD (controlador + link de política), enviar mensagem; a conversa aparece no Inbox com o selo "Chat no site"; responder pelo Inbox e a resposta aparece na janela | `tests/e2e/chat-no-site.spec.ts` "C4" |
| C5 | Site fora da lista | O iframe não carrega (`frame-ancestors` não inclui a origem); prova pela ausência do conteúdo da janela | `tests/e2e/chat-no-site.spec.ts` "C5" |
| C6 | Girar a chave | Página com o código antigo mostra "Chat indisponível" ao abrir conversa nova | `tests/e2e/chat-no-site.spec.ts` "C6" |
| C7 | Pausar o chat | `/chat/<chave>` passa a dar 404/indisponível; retomar volta a abrir | `tests/e2e/chat-no-site.spec.ts` "C7" |

## O que não está neste roteiro

- Formatos da janela (painel, embutido, página inteira) — F2-B (Tarefa 9)
- Horário de atendimento (janela por dia, feriado, fora do expediente) — F3 da issue #1333
- Teto do visitante anônimo — F4 da issue #1333
