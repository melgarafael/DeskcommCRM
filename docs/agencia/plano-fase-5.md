# Plano de implementação — Fase 5 (formulário e cofre de acessos)

> Estado: **construída e publicada no teste.emmovimento.tech** em 26/10/2026, branch
> `feat/agencia-fase-5` (sai da Fase 4). Prova pela tela em `evidence/agencia-fase-5/`.
> Spec: [`SPEC-cofre-e-formulario`](SPEC-cofre-e-formulario.md), decidida pelas sugestões.
>
> **Verificação (26/10/2026):** typecheck e lint limpos; testes do formulário 8/8 (CNPJ,
> rascunho e cópia sem senha, pendências, validade do link); no Postgres da VPS, baseline
> install + update sem erro e 97/97 invariantes da agência (9 novos). No teste: o membro
> gera o link (função temporária, retirada depois); o "cliente", num navegador sem sessão e
> no celular, preenche em etapas (CNPJ com máscara), recarrega no meio e o rascunho volta,
> marca Google e TikTok como "não tem", envia; o link passa a dizer que já foi enviado. Na
> ficha: respostas, 2 acessos no cofre com a senha cifrada, "Ver senha" mostra a senha certa
> e registra; o relatório PDF sai (200, application/pdf) e registra cada item. Sem
> `cofre.ver_senhas`: senha mascarada, sem botão, e o relatório responde 403. Varredura no
> banco: **nenhuma ocorrência da senha em claro** no formulário, no cofre, nos avisos, no
> WhatsApp, na auditoria ou no `event_log`. O cadastro recebeu CNPJ, WhatsApp, e-mail,
> Instagram e responsável, e manteve a razão social que já existia.
>
> **Achados na prova e consertados:** (1) a mudança de Configurações da Fase 4 (alerta de
> avisos gerais) tinha um erro de tipo que só o build pegou — foi publicada no teste sem o
> typecheck, o build falhou e o app seguiu na imagem anterior; o arquivo foi corrigido no
> teste e entra corrigido nesta fase. Regra a partir daqui: typecheck antes de todo commit e
> de toda publicação. (2) O exemplo do campo de site usava um domínio de exemplo que a cerca
> de branding acusa; trocado por texto.
>
> **Não provado ainda:** envio de arquivos pelo formulário (depende do Drive conectado), o
> link pelo WhatsApp (depende do número da agência) e o aviso "formulário preenchido"
> chegando a alguém (no teste ninguém recebe avisos gerais — Configurações mostra o alerta).
> O PDF da prova não foi versionado porque contém as senhas (de teste).

## Decisões de arquitetura

- **Migration 9007** + apêndice no baseline antes da varredura de anon.
- **Token só em hash**, igual ao convite; rota pública em `lib/auth/public-paths.ts` e
  limite de tentativas por IP e por link (`checkRateLimit`).
- **Senha só existe em claro** dentro de `lib/agencia/cofre/cofre.ts` (cifrar, decifrar
  para quem pode) e no PDF gerado na hora; o vocabulário que a tela usa mora em
  `lib/agencia/cofre/vocabulario.ts`, para a chave de cifra nunca entrar no pacote do
  navegador.
- **Fechamento atômico** do formulário: dois envios juntos, só um passa.
