# Instalar para clientes (agências e revendedores)

Guia para quem instala o DeskcommCRM **para outras empresas** — agência, consultoria, revendedor — e cobra por isso.

A licença é MIT: você pode modificar, hospedar para terceiros, revender e cobrar o que quiser. Não há royalty, não há cláusula proibindo hospedagem comercial e não existe versão paga que trave funcionalidade do seu cliente.

---

## Trocar a marca

Duas variáveis no `.env`, sem tocar em código:

```bash
APP_NAME=Vendas Turbo CRM
APP_LOGO_URL=https://cdn.suaempresa.com.br/logo.svg
```

Reinicie a stack (`docker compose up -d`) e a marca vale em toda a interface: título das abas, tela de entrada, cadastro, recuperação de senha, verificação em duas etapas, onboarding e a barra lateral.

`APP_LOGO_URL` é opcional — sem ela, o nome aparece como texto. Com ela, o logo substitui o texto na barra lateral. A altura é fixa e a largura é livre, para não distorcer arte de proporção qualquer.

O `install.sh` pergunta o `APP_NAME` durante a instalação; pressionar Enter mantém o padrão.

### Por que isso é configuração, e não uma edição de código

Trocar a marca editando os arquivos-fonte funciona **uma vez**. No próximo `bash update.sh`, a imagem nova sobrescreve o patch e a marca do seu cliente volta a ser a nossa — normalmente sem ninguém perceber, até o cliente ver.

Configuração no `.env` sobrevive a toda atualização. É por isso que a marca é lida em tempo de execução e não embutida na compilação: uma única imagem Docker serve qualquer marca.

### O que ainda não é configurável

Sendo direto, para você não descobrir na frente do cliente:

- **Cores, fontes e tema** não são configuráveis por variável. Exigem alterar o design system (`app/globals.css` e os tokens), e essa alteração **é** um patch que se perde no update.
- **A marca é por instalação, não por organização.** Uma instalação com várias organizações mostra a mesma marca para todas. Se cada cliente precisa da própria marca, use uma instalação por cliente (ver abaixo) — que também é o modelo que rende melhor.
- **Textos e e-mails transacionais** seguem o padrão do produto.

---

## Um cliente por instalação, ou todos numa só?

O sistema é multi-tenant desde a primeira linha: uma instalação atende várias organizações, e o isolamento entre elas é verificado no CI a cada alteração — um usuário de uma organização não enxerga nenhuma linha de outra. Não é promessa de marketing: é o teste `tests/invariants/rls-isolation.test.ts`, que cria duas organizações e prova o não-vazamento pelo mesmo caminho de autenticação que a produção usa.

Mesmo assim, os dois modelos servem a propósitos diferentes:

| | Uma instalação por cliente | Uma instalação para todos |
|---|---|---|
| **Marca** | A de cada cliente | Uma só, a sua |
| **Custo de infra** | Uma VPS por cliente | Uma VPS |
| **Falha** | Isolada | Atinge todos |
| **Atualização** | Uma por vez, pode escalonar | Todos de uma vez |
| **Dado do cliente** | Fisicamente separado | Separado por RLS |
| **Melhor para** | Revender com a marca do cliente | Sua própria operação atendendo várias contas |

Se o seu cliente pergunta "onde ficam meus dados?", a instalação dedicada tem a resposta mais simples de dar — e de defender.

---

## O argumento jurídico que fecha venda no Brasil

A **Resolução CD/ANPD nº 19/2024** tornou obrigatórias as cláusulas-padrão contratuais para **transferência internacional de dados pessoais**, com o prazo de adequação encerrado em **23 de agosto de 2025**.

Todo cliente seu que usa um CRM estrangeiro realiza essa transferência e precisa do artefato contratual. Hospedando em VPS no Brasil, **não há transferência internacional** — e a obrigação não se aplica.

⚠️ **Não venda como "servidor no Brasil = conformidade com a LGPD".** Isso é falso e um advogado desmonta na primeira pergunta: conformidade depende de base legal, finalidade, segurança e direitos do titular. O argumento correto e defensável é o de cima: sem transferência internacional, não há exigência de cláusulas-padrão.

---

## Operação

Cada instalação traz os scripts em `hostgator-setup-kit/`:

| Comando | O que faz |
|---|---|
| `bash update.sh` | Atualiza. Faz backup do banco **antes**, reaplica o schema de forma idempotente e confere a saúde no fim |
| `bash backup.sh` / `restore.sh` | Backup e restauração |
| `bash reset-password.sh` | Redefine a senha de um usuário |
| `bash reset-mfa.sh` | Remove a verificação em duas etapas de quem perdeu o aparelho |
| `bash healthcheck.sh` | Diagnóstico da instalação |

O `reset-mfa.sh` é o que você mais vai usar: a verificação em duas etapas é obrigatória para administradores, e trocar de celular sem salvar os códigos de recuperação é a chamada de suporte mais comum.

---

## Requisitos por instalação

2 GB de RAM, portas 80 e 443, Docker Compose v2 e um domínio com registro A apontando para o IP. A VPS não compila nada — baixa uma imagem pronta. O certificado HTTPS é emitido automaticamente no primeiro acesso.

Guia completo de instalação: [`hostgator-setup-kit/README.md`](../hostgator-setup-kit/README.md).

---

*Última atualização: 27 de julho de 2026.*
