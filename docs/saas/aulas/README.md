# Roteiros de aula: o seu SaaS com o DeskcommCRM

Cinco aulas, na ordem da [jornada do revendedor](../README.md). Cada roteiro diz o que a aula
entrega, o que preparar antes de gravar, as cenas, o que mostrar na tela, o erro que vale a
pena mostrar acontecendo e a tarefa do aluno.

Os roteiros **não repetem** os passos: eles apontam para o guia que é a fonte, e quem grava
segue o guia na tela. Quando o guia mudar, a aula muda junto, sem texto duplicado para
envelhecer.

| # | Aula | Guia de referência |
|---|---|---|
| 1 | [Do servidor vazio ao Coolify](01-servidor-e-coolify.md) | [`../coolify.md`](../coolify.md), Passos 0 a 4 |
| 2 | [O CRM e o banco no ar](02-instalar-o-crm.md) | [`../coolify.md`](../coolify.md), Passos 5 e 6 |
| 3 | [Primeiro dia de dono e primeiro cliente](03-primeiro-cliente.md) | [`../README.md`](../README.md), etapas 1, 3 e 4 |
| 4 | [Cobrar: planos, Stripe ou Asaas, régua](04-cobrar.md) | [`../cobranca.md`](../cobranca.md) |
| 5 | [Manter: custo, atualizar, backup e contrato](05-manter.md) | [`../coolify.md`](../coolify.md) e [`../contrato-e-lgpd.md`](../contrato-e-lgpd.md) |

## Antes de gravar qualquer aula

- Use uma **VPS de teste** e um **domínio de teste**. Nada de produção na tela.
- **Nunca mostre** senha, chave de API, token, o bloco "Credenciais iniciais" do instalador,
  nem o arquivo `.env`. Se um aparecer, corte a cena e troque a chave.
- Chaves de cobrança na tela: só as de **teste** (`sk_test_`, `rk_test_`, `$aact_hmlg_`), e
  mesmo essas borradas.
- Confira a versão que você vai mostrar: `curl -s https://SEU_DOMINIO/api/v1/health` devolve
  `"version"`. Diga essa versão na aula: telas mudam entre versões.
