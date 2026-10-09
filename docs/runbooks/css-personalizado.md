# CSS personalizado: quando a folha tranca a tela

O CSS personalizado da instalação (Marca da instalação › CSS personalizado, chave
`APP_CUSTOM_CSS` em `public.platform_config`) vale no login e em todas as telas.
O validador recusa o que carrega recurso, sai da tag `<style>` ou mexe em layout,
mas uma folha **válida** ainda pode deixar texto invisível (`color: transparent`,
`font-size: 0`) ou cobrir a tela com `box-shadow` — inclusive o login e a tela
que desfaz o estrago. Quem pode gravar é só o dono da instalação, com acesso
completo; o risco é ele se trancar fora, não um terceiro.

## Saída pela tela: `?sem_css=1`

Qualquer página aberta com `?sem_css=1` no endereço vem **sem** a folha, só para
quem pediu (o `proxy.ts` traduz o parâmetro num cabeçalho que o `app/layout.tsx`
lê; ver `lib/branding/sem-css-personalizado.ts`).

1. Abra `https://SEU-DOMINIO/login?sem_css=1` e entre.
2. Digite na barra `https://SEU-DOMINIO/admin/marca?sem_css=1` (a navegação por
   link dentro do app não recarrega o layout; o endereço digitado, sim).
3. Apague o conteúdo do campo **Regras CSS** e clique em **Salvar CSS**.

## Saída pelo servidor

Sem acesso à tela:

```bash
psql "$SUPABASE_DB_URL" -c "delete from public.platform_config where chave = 'APP_CUSTOM_CSS';"
```

O app guarda a folha em memória por até 30 segundos; depois disso ela some de
todas as telas, sem reiniciar nada. A remoção é auditada só quando feita pela
tela (`platform_branding.updated`).

## Se o CSS sumiu sozinho

Folha que deixou de passar na validação (por exemplo, depois de uma atualização
que apertou o validador) não é aplicada: a tela Marca mostra o motivo, e o log do
app registra `custom_css_invalid`. Se o log mostra `custom_css_unavailable`, o
validador não carregou nesta imagem; as telas seguem sem o CSS personalizado.
