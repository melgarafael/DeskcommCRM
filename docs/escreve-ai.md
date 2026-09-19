# escreve.ai — identidade e operação

## Repositório e versões

- Repositório privado: [saraivabr/escreve.ai](https://github.com/saraivabr/escreve.ai).
- `versao-atual`: branch padrão, com as personalizações existentes.
- `integracao-oficial`: incorpora as atualizações do projeto original; sua validação completa continua pendente no PR de integração.
- [PR de integração](https://github.com/saraivabr/escreve.ai/pull/1): não significa publicação em produção.
- O nome da marca é **escreve.ai**, sempre em minúsculas. O nome não comprova registro de domínio, DNS ou mudança do endereço de produção.

## Origem e licença

Baseado no [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM), de Rafael Melgaço e colaboradores. A [licença MIT](../LICENSE), os créditos e o histórico Git são preservados.

Changelogs, handoffs, planos, relatórios e fragmentos de releases anteriores são registros históricos. Neles, DeskcommCRM e Saraiva identificam o projeto ou a instalação na época. Links para issues, commits e PRs do projeto original continuam apontando para sua fonte verdadeira.

## Desenvolvimento e contribuição

Clone esta edição com acesso à conta autorizada no GitHub:

```bash
git clone --branch versao-atual https://github.com/saraivabr/escreve.ai.git
cd escreve.ai
```

Crie branches de trabalho a partir de `versao-atual`; abra PRs contra essa branch. Para continuar a integração oficial, use `integracao-oficial`. As menções a `main`, publicações automáticas e políticas do mantenedor original nos guias herdados descrevem o upstream e não substituem este fluxo.

Mantenha o upstream separado:

```bash
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream
```

Em clones existentes, atualize apenas o remote que apontava para `saraivabr/saraiva-crm`; preserve outros remotes e alterações locais. Consulte [contribuição](../CONTRIBUTING.md) e [arquitetura](../ARCHITECTURE.md) para os contratos técnicos.

## Instalação e atualização

Os scripts em `hostgator-setup-kit/` são herdados do projeto original. URLs de instaladores, imagens Docker, releases e atualizadores que apontam para `melgarafael/DeskcommCRM` instalam ou atualizam a distribuição original; não garantem as personalizações escreve.ai.

Para distribuir esta edição, é necessário compilar a revisão escolhida, selecionar a imagem própria e validar banco, workers e canais antes de atualizar uma instalação. Este repositório ainda não anuncia um instalador ou imagem pública escreve.ai. As GitHub Actions estão desativadas; um push não publica uma versão nem executa CI automaticamente.

Parcerias, SLAs, badges de CI e promessas de publicação descritos em documentos herdados pertencem ao projeto original, salvo configuração explícita desta edição.

## Marca e compatibilidade

A identidade exibida pelo CRM é configurada pelos mecanismos de branding existentes; consulte [white-label](white-label.md). A renomeação do repositório e da documentação não altera uma instalação em produção.

Nomes de pacotes, caminhos, scripts `deskcomm-*`, cookies, cabeçalhos de assinatura, imagens, variáveis e identificadores persistidos permanecem quando são contratos técnicos. Não os renomeie por substituição textual: isso pode quebrar integrações, sessões e atualizações.

## Mapa da documentação

- [Índice técnico](index.md)
- [Visão do produto](../VISION.md)
- [Arquitetura](../ARCHITECTURE.md)
- [Estado de implementação](current-state.md)
- [Prospecção nativa](features/prospeccao-nativa.md)
- [Segurança](../SECURITY.md)
- [Contribuição](../CONTRIBUTING.md)
