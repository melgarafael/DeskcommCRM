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
