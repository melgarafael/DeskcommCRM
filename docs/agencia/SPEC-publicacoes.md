# SPEC — Publicações (Fase 8b)

> Módulo `publicacoes` do [mapa de capacidades](mapa-de-capacidades.md). Decidida em
> 26/10/2026 sem parar para aprovação (pedido do dono: as fases seguem uma após a outra).

## O que resolve

Cada cliente tem um **calendário de postagens**: o que vai ao ar, em que rede, em que
dia e hora, com que legenda e mídia. A agência vê o mês inteiro de um cliente (ou de
todos) e sabe o que falta aprovar, o que está agendado e o que já foi publicado.

## Regras

| # | Regra |
|---|---|
| P1 | Publicação pertence a **um cliente** e tem: título interno, rede (`instagram`, `facebook`, `tiktok`, `youtube`, `outra`), formato (`feed`, `reels`, `story`, `carrossel`, `video`), data e hora (fuso da agência), legenda, link da mídia (https), responsável (membro) e situação. |
| P2 | Situações: `rascunho` → `em_aprovacao` → `aprovada` → `agendada` → `publicada`; ou `falhou` / `cancelada`. Só quem tem `publicacoes.gerenciar` cria, edita e muda situação. Todo membro que alcança o cliente vê. |
| P3 | **Pedir aprovação** a partir da publicação reaproveita a Fase 7: cria uma linha em `agencia_aprovacoes` com `publicacao_id` e põe a publicação em `em_aprovacao`. Quando o cliente responde, a publicação acompanha: aprovado → `aprovada`; ajustes → volta a `rascunho` com o comentário guardado. |
| P4 | **Marcar como publicada** à mão (com link opcional do post) sempre existe — é o caminho de toda rede. |
| P5 | **Publicação automática** só para Instagram e Facebook, pela Meta, e só quando a chave "Publicar sozinho" da publicação estiver ligada (**desligada por padrão**). Exige: publicação `aprovada`, o cliente ligado a uma organização com conexão Meta (`social_insights_connections` — a mesma do painel de anúncios), e link de mídia **direto e público** (a Meta baixa o arquivo; link de pasta do Drive não serve). Ligada a chave, a publicação passa a `agendada`. |
| P6 | O relógio da agência (cron `agencia-prazos`, a cada 15 min) publica as `agendadas` cujo horário chegou. Deu certo → `publicada` com o id e o link do post. Deu errado → `falhou` com o motivo legível, e um aviso vai para o responsável (ou para os avisos gerais). Nunca tenta de novo sozinho: quem resolve volta a agendar. Uma publicação é tomada por uma rodada só (`update ... where situacao='agendada'` com troca para `publicando`). |
| P7 | Formatos automáticos: Instagram `feed` (imagem), `reels` (vídeo) e `story`; Facebook `feed` (foto ou link). Carrossel e TikTok/YouTube: só manual nesta fase (pesquisa depois, como o mapa manda). |
| P8 | Vale o anti-surpresa do dinheiro? Publicar não gasta dinheiro, mas fala em nome do cliente — por isso a chave nasce desligada e só publicação **aprovada** pode ser agendada. |

## Dados (migration 9011)

- `agencia_publicacoes` — instalação (sem `organization_id`, como as demais tabelas da agência; acesso só pelo servidor).
- `agencia_aprovacoes.publicacao_id uuid null references agencia_publicacoes on delete set null`.
- `auto_publicar boolean default false`, `post_id`, `post_url`, `erro`, `publicada_em`.

## Telas

- `/agencia/publicacoes` — calendário do mês (grade no computador, lista no celular), filtro por cliente, botão "Nova publicação", painel lateral de edição com as ações (Pedir aprovação, Agendar/Publicar sozinho, Marcar como publicada, Cancelar).
- Menu "Publicações".

## O que NÃO está provado

A chamada real à Meta (Graph API `/{ig-user-id}/media` + `/media_publish`, e `/{page-id}/photos` ou `/feed`) não foi exercida com conta real: não há conexão Meta com permissão `instagram_content_publish`/`pages_manage_posts` no teste. O caminho de falha (sem conexão, sem token, link inválido) é provado pela tela.
