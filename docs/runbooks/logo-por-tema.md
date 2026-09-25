# Logo por tema: compatibilidade e reversão

A mudança 0406 acrescenta `platform_branding.logo_dark_path` e o campo homônimo em `organizations.settings.branding`. O bucket e as regras de tamanho, formato, autorização e auditoria são os mesmos do logo padrão. O upload conserva os bytes da imagem.

A rota `POST/DELETE /api/v1/marca/logo` aceita `tema=claro|escuro`; omitir o tema conserva o contrato antigo (`claro`). A resposta mantém `logo_path` e `logo_url`, relativos ao tema pedido. O RPC antigo delega ao mesmo escritor com o tema claro. Nome/cor não alteram os ponteiros dos arquivos.

## Operação

Em Marca, envie o logo padrão e, se desejar, o logo para o tema escuro. A prévia mostra o resultado nos dois fundos. O segundo arquivo é opcional e deve ter contraste sobre fundo escuro; o sistema não modifica sua cor nem acrescenta moldura. O login usa a instalação; o menu usa a organização. E-mails continuam usando o logo padrão.

## Reversão

Para desfazer a escolha visual, remova o logo escuro pela própria tela. O padrão volta a aparecer no escuro com a proteção branca anterior.

Para reverter a versão do aplicativo, restaure a imagem anterior registrada na implantação. A migration é aditiva: deixe coluna, função e dados no banco; não é necessário apagar nenhum arquivo ou restaurar o banco para voltar ao código anterior. Essa versão ignora a arte escura, e o RPC legado continua funcionando. Preserve o backup e confira login, marca e funcionamento da aplicação após a reversão.

## Checklist de integração

- Entrada: campos da tela de marca, autorizados por escopo; os dois temas passam pela mesma rota.
- Saída: resolvedor → menu, login e prévia; e-mails permanecem no padrão claro.
- Registro: `org.branding_updated` ou `platform_branding.updated`, com tema e campo alterado.
- Acesso/configuração: páginas de marca já registradas na navegação; nenhum menu novo.
- Retorno: erros da rota aparecem na tela; a prévia aplica a resposta sem depender do refresh.
- Continuidade IA/humano: não se aplica, a mudança só representa a identidade visual.
- Próximo passo: remoção de cada arquivo restaura o fallback; não há fila nem atividade pendente.
- Mapa: `docs/architecture/marca-propria.architecture.json` descreve a mesma cadeia de consumidores.
