# Plano de implementação — Fase 8 (mapa mental e publicações)

A Fase 8 sai em duas partes, cada uma com o seu commit na branch `feat/agencia-fase-8`
(sai da Fase 7): **8a — mapa mental** ([SPEC-mapa-mental](SPEC-mapa-mental.md)) e
**8b — publicações** ([SPEC-publicacoes](SPEC-publicacoes.md)).

## 8a — Mapa mental

> Estado: **construída, publicada no teste.emmovimento.tech e provada** em 26/10/2026.
> Prova pela tela em `evidence/agencia-fase-8/` (01 a 04).
>
> **Verificação:** typecheck e lint limpos; no Postgres da VPS, baseline install + update sem
> erro e os invariantes da agência verdes, com `agencia-fase-8.test.ts` (tabelas sem acesso de
> anon/authenticated, CHECKs, seta sem laço, cascata do mapa). A única falha da suíte é a do
> Bling, que já existia no fork.
>
> **Prova pela tela** (membro de teste com uma função temporária "Mapa (prova F8)", que tinha
> `mapa.editar` e `tarefas.atribuir` e foi apagada depois): o membro criou o mapa "Plano de
> dezembro" da Empresa Modelo e montou quatro blocos em sequência: Roteiros → Gravação →
> Edição (executor IA) → Aprovação do cliente (marco). Arrastou "Gravação" 220 × 140 px, e a
> posição continuou a mesma depois de recarregar. A seta Edição → Roteiros foi recusada com
> "Essa seta fecharia um círculo." Depois de publicar, só Roteiros ficou liberado e virou tarefa.
> Quando a tarefa foi concluída no quadro, Gravação foi liberada. Com 375 px a tela mostra a
> lista, esconde o desenho e não rola para o lado.
>
> **Achados na prova e consertados:**
> 1. Um bloco novo nascia em cima de outro e impedia o clique. Agora ele vai para o primeiro
>    lugar livre (`lugarLivre()`).
> 2. Um bloco novo podia nascer fora da parte visível do desenho, e parecia não ter sido
>    criado. Agora o lugar livre só conta a largura visível, e a área rola até o bloco quando
>    ele fica abaixo dela.
>
> **Não provado:** o executor IA só fica marcado no bloco; quem executa é a Fase 9.

### Decisões de arquitetura

- **Migration 9010** + apêndice no baseline: `agencia_mapas`, `agencia_mapa_blocos`,
  `agencia_mapa_ligacoes`, todas da instalação. Têm RLS ligada, `revoke all` e são acessadas só
  pelo servidor.
- As regras puras ficam em `lib/agencia/mapas/regras.ts`: `problemaNoMapa` acha círculo, bloco
  sem título e marco com responsável. As cores ficam em `CORES_DO_BLOCO`. Os testes estão em
  `tests/unit/agencia-mapas-regras.test.ts`.
- O motor fica em `lib/agencia/mapas/motor.ts`. Publicar libera os blocos sem dependência e
  cria a tarefa de cada um. `aoMudarTarefaDoMapa` é chamado pelo mesmo gancho da trilha
  (`aoMudarTarefa`): tarefa concluída conclui o bloco e libera os que dependiam dele. Um marco
  se conclui à mão (`concluirMarcoDoMapa`).
- Ações em `app/actions/agencia/mapas.ts`, todas com `mapa.editar`. As setas só mudam em
  rascunho e recusam círculo.
- A tela (`components/agencia/mapas/TelaDoMapa.tsx`) é HTML + SVG, com arrasto por pointer
  events, um painel lateral e a lista no celular. O menu ganhou "Mapas".
- Auditoria: `agencia.mapa_criado`, `agencia.mapa_publicado`, `agencia.mapa_arquivado`.

## 8b — Publicações

> Estado: **construída, publicada no teste.emmovimento.tech e provada** em 26/10/2026.
> Prova pela tela em `evidence/agencia-fase-8b/` (01 a 05).
>
> **Verificação:** typecheck e lint limpos, 6 testes das regras
> (`tests/unit/agencia-publicacoes-regras.test.ts`). No Postgres da VPS, baseline install +
> update sem erro e os invariantes da agência verdes, inclusive as publicações em
> `agencia-fase-8.test.ts`: tabela fora do alcance de anon/authenticated, rede, formato e
> situação fechadas, mídia e post só https, `publicacao_id` da aprovação com `on delete set null`
> e cascata do cliente. A única falha da suíte é a varredura de RLS acusando Bling e
> `social_insights`, que já existia no fork.
>
> **Prova pela tela** (membro de teste com uma função temporária "Publicações (prova F8b)", que
> tinha `publicacoes.gerenciar` e `tarefas.criar`. Para responder como cliente, ele entrou
> temporariamente como agent na Empresa Modelo, e os dois acessos foram retirados depois):
> 1. O membro criou o Reels de 12/11 às 18:30 com a legenda e o link do Drive, e ele apareceu na
>    grade como Rascunho.
> 2. "Pedir aprovação ao cliente" mudou a situação para "Com o cliente". O cliente viu a legenda
>    em /app/aprovacoes e pediu ajustes. A publicação voltou para Rascunho com o comentário.
> 3. A agência trocou a legenda e pediu de novo, e o cliente aprovou: Aprovada.
> 4. "Agendar e publicar sozinho" foi recusado **antes de qualquer chamada à Meta** porque o link
>    é de pasta do Drive. O agendamento para postar à mão funcionou.
> 5. A publicação foi marcada como publicada, com o link do post, e os campos ficaram travados.
> 6. Com 375 px a tela mostra a lista, esconde a grade e não rola para o lado.
>
> **Relógio** (diagnóstico pelo banco e pela rota do cron, que é o caminho real do agendador):
> uma publicação agendada com "publicar sozinho", de um cliente sem organização, foi tomada pela
> rodada, ficou como `falhou` com "O cliente não está ligado a uma organização do CRM." e
> auditada em `agencia.publicacoes_publicadas`, sem nova tentativa.
>
> **⚠️ Achado de segurança da prova:** a organização "Empresa Modelo (Testes)" tem **conexão
> Meta real** (página e Instagram com token). Por isso a prova nunca ligou "publicar sozinho"
> nela. Quem testar a publicação automática deve usar uma conta de teste da Meta, nunca essa
> organização.
>
> **Não provado:**
> - A chamada real à Graph API (container + `media_publish` no Instagram e `/photos` na página).
> - O aviso de "não publicou": a rodada chama `criarAviso`, mas no teste ninguém recebe os avisos
>   gerais (pendência do dono: ativar o perfil de membro com `avisos.gerais`).
> - O nome do mês aparece "Novembro De 2026" (a classe `capitalize` põe maiúscula em toda
>   palavra). O conserto vai na Fase 9.

### Decisões de arquitetura

- **Migration 9011** + apêndice no baseline. `agencia_publicacoes` é da instalação, como as
  outras tabelas da agência, e `agencia_aprovacoes.publicacao_id` liga a aprovação à
  publicação.
- As regras puras ficam em `lib/agencia/publicacoes/regras.ts`: `publicaSozinho`,
  `linkDeMidiaDireto`, `problemaParaAgendar` e `mudouOConteudo`. Mudar o que o cliente aprovou
  volta a publicação para rascunho e cancela a aprovação pendente.
- `lib/agencia/publicacoes/meta.ts` fala com a Graph API v21.0, com o token no cabeçalho. Usa a
  conexão que já existe em `social_insights_connections` (`lerConexaoSocial`).
- `lib/agencia/publicacoes/motor.ts`:
  - `aoResponderAprovacaoDaPublicacao` é chamado por `registrarResposta` da Fase 7.
  - `publicarAgendadas` roda no cron `agencia-prazos` (a cada 15 min), sem mudar o agendador.
    A trava é `agendada → publicando` no próprio UPDATE. Uma publicação parada em "publicando"
    por mais de 15 min vira "falhou", sem repetir.
- A tela fica em `/agencia/publicacoes` (`CalendarioDePublicacoes`), com o menu "Publicações" e a
  permissão `publicacoes.gerenciar`. Os avisos novos são `publicacao_feita` e
  `publicacao_falhou`.
- Auditoria: `agencia.publicacao_salva`, `_agendada`, `_marcada_publicada`, `_cancelada` e
  `agencia.publicacoes_publicadas` (só quando a rodada fez algo).
