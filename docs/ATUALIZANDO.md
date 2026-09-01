# Atualizando o SonghaiCRM na sua VPS

Saiu uma versão nova? Atualizar é **um comando só**. Você não precisa saber se a
novidade é no código, no banco de dados ou nos dois — o comando cuida de tudo, na
ordem certa e com backup automático antes de mexer em qualquer coisa.

## O que fazer

Entre no seu servidor (o mesmo acesso SSH que você usou pra instalar), vá até a pasta
do projeto e rode:

```bash
bash self-host-kit/update.sh
```

Pronto. Pode deixar rodando — leva alguns minutos. No fim, você vê **`✓ Atualização
concluída — app no ar e saudável`**. Se ele disser que você **já está na versão mais
recente**, é porque não havia nada novo pra baixar; está tudo certo.

## O que o comando faz (por baixo)

1. Confere se há mesmo uma versão nova.
2. **Faz um backup do banco** — a rede de segurança, antes de tocar em qualquer coisa.
3. Baixa o código novo.
4. Atualiza o banco de dados (inclusive corrigindo sozinho conversas bagunçadas de
   versões antigas).
5. Baixa a versão nova do aplicativo e reinicia.
6. Confere se o CRM voltou no ar.

## Coisas normais que você pode ver (não se assuste)

- **Um monte de linhas com "already exists" / "multiple primary keys"** durante a parte
  do banco: **é esperado e inofensivo** — são coisas que já existiam. O comando filtra
  esse ruído e, se estiver tudo certo, mostra **`✓ banco atualizado`**.
- Se aparecer **`⚠ avisos que não são os esperados`**, aí sim vale prestar atenção: o app
  provavelmente ainda funciona, mas guarde a mensagem. Em último caso, dá pra voltar ao
  estado anterior com o backup: `bash self-host-kit/restore.sh`.

## Dicas

- **Quando rodar?** Sempre que avisarem que saiu versão nova. Rodar sem ter novidade não
  faz mal — o comando só diz "já está na última" e sai.
- **Automático (opcional):** dá pra agendar pra toda semana. Rode `crontab -e` e adicione
  (troque o caminho pela pasta do seu projeto):
  ```
  0 4 * * 0  cd /caminho/do/deskcommcrm && bash self-host-kit/update.sh
  ```
  Isso atualiza todo domingo às 4h da manhã, já com backup automático.
- **Deu algo estranho?** Rode `bash self-host-kit/healthcheck.sh` pra ver o estado
  de tudo de uma vez.
