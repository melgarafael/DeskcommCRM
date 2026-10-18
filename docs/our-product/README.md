# Camada do nosso produto

Esta pasta documenta o que é nosso em cima do fork do DeskcommCRM. Ela não muda o comportamento do produto.

## O que é upstream e o que é nosso

| Nome | Onde aponta | O que é |
|---|---|---|
| `upstream` | `https://github.com/melgarafael/DeskcommCRM.git` | Projeto original. Continua sendo a fonte das melhorias do CRM. |
| `origin` | `https://github.com/vinicasagranda/DeskcommCRM.git` | Nosso fork. |
| `docs/our-product/` | neste repositório | Decisões, arquitetura-alvo e rotina de sincronização da nossa camada. |

Licença do projeto-base: MIT. Qualquer distribuição comercial precisa respeitar essa licença e não tratar imagem Docker como barreira de código-fonte.

## Como desenvolver

- `main` acompanha o que já foi aceito. Não desenvolver direto nela.
- `develop` é a linha de integração das nossas mudanças.
- Feature entra por `feature/*`, correção por `fix/*`, correção urgente por `hotfix/*`, corte por `release/*`.
- Atualização do upstream entra por uma branch `chore/sync-upstream-AAAA-MM-DD`, nunca direto em produção. O procedimento está em [UPSTREAM-SYNC.md](UPSTREAM-SYNC.md).

## Precedência

Para o código herdado, a doutrina do upstream continua valendo:

`CLAUDE.md` > `docs/specs/` > `docs/prd/` > handoffs > README.

Os arquivos desta pasta descrevem a camada que vamos acrescentar. Eles não substituem `CLAUDE.md`. Se uma decisão nossa conflitar com multi-tenancy, RLS, auditoria, idempotência ou packaging, a doutrina do upstream ganha e a decisão é reescrita.

## O que esta camada não faz agora

Não há ERP, Hub, billing, licenciamento nem módulo novo neste commit. O próximo passo, depois da linha de base de testes, é marca e o módulo piloto — um de cada vez.
