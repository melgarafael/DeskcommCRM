# Chat no site — F5 (origem da página) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Antes de qualquer código: skills `deskcomm-contribuir`, `deskcomm-doutrina` e `sistema-vivo`.

**Goal:** a primeira mensagem do visitante leva a página, o referrer e as UTMs, e a ficha do contato ganha a origem pelo mesmo caminho que a landing com `wa.me` já usa, com a mesma guarda de primeiro toque do banco.

**Medido (24/11):** a janela guarda o contexto da página em `estado.contexto` (`{ href, referrer, utm }`, já aparado e cortado em 200 caracteres) mas NUNCA o envia; o corpo de `POST /api/v1/webchat/mensagens` só tem `mensagem_id`, `texto`, `aceite` e `contato`, e o schema é `.strict()`. `estamparOrigemDaPagina` (`lib/leads/origem-do-site.ts`) só é chamado por `pos-entrada.ts` (código `dk1` no texto) e por `origem-por-horario.ts`: o chat não usa.

**Architecture:** o contexto viaja no corpo da PRIMEIRA mensagem (como o `aceite` e o `contato`). A rota o valida; a ingestão, só na primeira mensagem, guarda `{ href, referrer }` no `metadata` da mensagem e chama `estamparOrigemDaPagina` com as UTMs normalizadas por `normalizarUtm`. Falha ao estampar nunca derruba a mensagem. Sem migration: `fn_estampar_atribuicao_de_anuncio` já tem a guarda de primeiro toque.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, seção "F5 — Origem e relatório". Issue #1333.

## Global Constraints

- Sem migration, sem variável de ambiente nova, nenhum nome de provedor fora de `lib/channels/`, sem `console.log`.
- `organization_id` vem da conexão resolvida pela chave, nunca do corpo. O contexto é "rótulo de origem, não permissão": nada nele decide acesso.
- Só a PRIMEIRA mensagem grava origem. Nas seguintes o contexto é ignorado.
- UTM só com as chaves de `CHAVES_DE_UTM` (use `normalizarUtm`); `href` e `referrer` com teto de 200 caracteres.
- Falha ao estampar a origem: `logger.warn` e a mensagem entra assim mesmo.

## Review Focus

- Contexto ausente (janela antiga) = nada muda. Contexto com UTM vazia = só `href`/`referrer` no metadata, sem estampar.
- UTM com chave fora da lista é descartada; valor acima de 200 é cortado, nunca recusa a mensagem.
- Segunda mensagem com contexto não estampa de novo.

## Tarefas

1. **Servidor** (`app/api/v1/webchat/mensagens/route.ts`, `lib/channels/webchat/ingest.ts` e os testes de ambos): o schema da rota aceita `contexto?: { href?: string; referrer?: string; utm?: Record<string, string> }` (strings com `max(200)`); a ingestão recebe `contexto` e, só em `primeira`, grava `metadata.webchat_pagina = { href, referrer }` na mensagem e chama `estamparOrigemDaPagina(admin, organizationId, contactId, { utm, capturadaEm: agora.toISOString() })` quando `normalizarUtm(contexto.utm)` não é vazio.
2. **Janela** (`public/webchat-janela.js`, `tests/unit/webchat-janela-cliente.test.ts`): na primeira mensagem (onde o `aceite` entra no corpo) a janela manda `contexto: { href, referrer, utm }` de `estado.contexto`, só se existir e tiver algum valor.
3. **Inbox e relatório** (medir antes): o selo "Chat no site" já existe (F1); conferir se o filtro por canal e o relatório por canal mostram o canal novo, e registrar o que falta.
4. **Documentos** (spec F5, caso C10, J74.12, mapa de arquitetura, fragmento `.changes/chat-no-site-parte-5.md`) e sabotagem.

## O que este plano não cobre

Relatório por página de origem (só por canal), e o "continuar no WhatsApp" com o código `dk1` (F4).

## Como cada tarefa é verificada antes de empurrar

Só o leve aqui: parser do TypeScript, `vitest.mjs` focado e `tsc` focado. Suíte inteira, e2e e `test:db` vão ao CI do fork. O executor (Haiku) só lê e escreve arquivos; quem roda a verificação e commita é o Claude.
