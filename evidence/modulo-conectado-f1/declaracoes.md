# Módulo conectado F1: declarações do PR

Este documento é a declaração que vai no corpo do PR da F1 (perfil `connected`, origem do serviço e
interruptor). Cada afirmação traz o comando que a produz. Nada aqui foi executado nesta máquina: o
veredito é o CI do fork.

## Destino (item 18 do Definition of Done)

**Infraestrutura da plataforma de extensões.**

Pergunta-raiz: *se nenhuma organização desta instalação ativar isto, a operação comum continua inteira?*
Sim. Sem nenhum módulo `connected` instalado:

- o perfil `connected` só é aceito quando a entrada do catálogo tem `service_origin`, e a regra que
  liga os dois está em `fn_extensions_finish_install` (migration 9115, espelho no baseline);
- o botão Ligar/Desligar só aparece para o perfil `connected` (`InstalledExtensionCard.tsx`);
- a nota "Desligado nesta instalação" só aparece quando há `disabled_at`, que só um `connected` tem;
- as 18 permissões de área são vocabulário novo que nenhuma operação lê ainda.

Se o mantenedor classificar a mudança como "ambos", o consumidor real do ponto novo do núcleo é o
primeiro módulo conectado, descrito na spec 33. Essa spec não está nesta branch: ela viaja em outro PR,
e este PR não a nomeia além disso.

Versão da API do host: **não sobe nesta F1.** `HOST_API_VERSION = 2` (`lib/extensions/manifest.ts:150`),
e os pacotes oficiais declaram `host_api: {min: 2, max: 2}`; subir para 3 suspenderia os três pacotes
em toda instalação. Verificação: `grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts`.

## Tela nova (item 14)

**Nenhuma.** `/admin/extensoes` já existe. O plano dizia que a porta dela estava em
`lib/navigation/catalogo.ts` (NAV_CATALOG); **não está**. Ela mora em `lib/admin/navegacao.ts`, e o
teste de completude de navegação (`tests/unit/navegacao-completude.test.ts`) só cobre `app/app/**`.

Verificação:

```bash
grep -n '"/admin/extensoes"' lib/admin/navegacao.ts      # linha 210
grep -c 'href:' lib/navigation/catalogo.ts               # rotas do /app; /admin/extensoes não está aqui
```

## Env nova (item 9)

**Nenhuma.** Verificação: `git diff --stat 299d2915e~1 HEAD -- .env.example lib/env.ts` sai vazio.

## Living System Checklist (item 13)

1. **Quem me alimenta.** A entrada do catálogo admitida por `fn_extensions_admit_catalog` (que aceita
   `service_origin`, migration 9115), o pacote lido por `parseManifest` (`lib/extensions/manifest.ts`),
   e a instalação criada por `fn_extensions_finish_install`. O clique vem de `ExtensionsManager.tsx`,
   que chama `POST /api/v1/extensions/[id]/switch`.
2. **Quem eu alimento.** `extension_installations.disabled_at`, lido por `lib/extensions/instalada.ts`,
   por `lib/extensions/view.ts` e pela tela. **Hoje nenhuma rota nega acesso por causa dele.** Os
   consumidores que vão ler são a F2 (o token deixa de valer) e a F4 (o grupo some), nomeados na spec
   33, que está em outro PR. Não são aresta presente, e este PR não afirma que são.
3. **Registro que emito.** `extension_operations` com `kind = 'switch'` (o recibo, com impressão
   digital do pedido e `applied_now`), e `api_audit_log` com a ação `extension.switched`
   (`lib/audit/actions.ts`), gravada em `switchExtension` (`lib/extensions/service.ts`) só quando
   `applied_now` é verdadeiro.
4. **Onde apareço na tela.** `components/extensions/InstalledExtensionCard.tsx` em `/admin/extensoes`:
   a nota "Desligado nesta instalação" com a data e o botão Ligar ou Desligar. Também a linha da
   instalação em `app/admin/(protected)/extensoes/page.tsx` (linhas 153 a 156).
5. **Por qual porta se chega.** `/admin/extensoes`, já em `lib/admin/navegacao.ts` (linha 210).
   Não é tela nova.
6. **Anti-morte.** Nenhum, com justificativa: o interruptor é estado de configuração decidido por
   quem administra a instalação. Não é demanda de uma pessoa que espera resposta, então não há próximo
   passo a garantir.
7. **Onde se configura.** O próprio botão no cartão. Quando a revisão mudou em outra sessão, a tela
   avisa, recarrega o estado e não anuncia sucesso (`staleInstallation`). Outras falhas aparecem como
   toast com a mensagem do erro.
8. **Continuidade IA↔humano.** Não se aplica. Nenhum agente passa por esta peça.
9. **Laço de retorno.** Hoje, quando a instalação conectada desligada erra, nada muda no sistema: a
   F1 só guarda e mostra o estado. O laço fecha quando a F2 e a F4 lerem `disabled_at`. Dívida
   declarada, não presumida, e nomeada como consumidor futuro na spec 33.
10. **Mapa.** `docs/architecture/extensoes-declarativas.architecture.json` ganha quatro nós,
    `connected_profile`, `switch`, `installation_flag` e `switch_ui`, cada um com pelo menos duas arestas.

## Afirmações de estado (item 16)

Só o que a F1 muda, e só nos documentos de autoridade (`docs/specs/extensoes-declarativas-v1.md`,
`docs/doctrine/extensoes.md`, a skill `deskcomm-extensao` e a pasta `references/`).

Falsas por causa da F1, corrigidas:

| Onde | O que dizia | O que fizemos |
|---|---|---|
| `docs/specs/extensoes-declarativas-v1.md` linha 29 | `profile: "declarative";` como único tipo | acrescentado o comando que lista os perfis |
| `docs/specs/extensoes-declarativas-v1.md` linha 134 | lista de ações auditadas sem `extension.switched` | acrescentado o ligar e desligar do `connected` |
| `.agents/skills/deskcomm-extensao/references/contrato-do-pacote.md` linha 34 | `profile` é "o único perfil que existe" | "declarative" para este guia, e o comando que lista os perfis |
| `.agents/skills/deskcomm-extensao/references/erros-do-pacote.md` linha 37 | `profile_unsupported` quando `profile` é diferente de "declarative" | "fora da lista que o host aceita", com o comando |
| `.agents/skills/deskcomm-extensao/SKILL.md`, Passo 2 | a lista de "o que ela faz" valia para toda extensão | escopo do perfil `declarative`, com o comando |

Verificadas e mantidas: `docs/doctrine/extensoes.md`. A tabela "existe / ainda não existe" continua
verdadeira, e a doutrina não cita contagem de perfis nem de permissões.

Encontrada e **não** tocada, porque é anterior à F1: `docs/specs/extensoes-declarativas-v1.md`
linha 34 diz "host atual = 1"; o código diz 2 (`grep -n "HOST_API_VERSION =" lib/extensions/manifest.ts`).

Espelho dos guias: `.claude/skills/deskcomm-extensao` **não** foi editado à mão. Precisa rodar
`pnpm skills:sync` antes do merge, e a página de guias da LP (`deskcomm-site`, `conteudo/guias.ts`)
acompanha.

## Fragmento de release

`.changes/modulo-conectado-interruptor.md`, com `impacto: capacidade_nova` e `secao: adicionado`. O
texto diz o que muda para quem opera a instalação e avisa que, nesta versão, desligar guarda e mostra
a decisão, sem cortar o acesso do serviço. Sem seção no `CHANGELOG.md`.

## Migrations (tripla)

- `supabase/migrations/20261104180100_9115_modulo_conectado_perfil.sql` (perfil, permissões, origem do serviço)
- `supabase/migrations/20261104190100_9116_modulo_conectado_interruptor.sql` (interruptor)
- `supabase/baseline.sql`: apêndice idempotente com os dois blocos.
- Cada migration tem `-- manifest:` na linha 1.

## O que NÃO medi

- **Nada foi executado nesta máquina.** Nenhum `pnpm`, `vitest`, typecheck, lint, build, Docker ou
  Playwright. O veredito de cada tarefa é o CI do fork.
- **As migrations 9115 e 9116 e o apêndice do baseline não foram aplicados** em nenhum Postgres. A ordem
  das recusas em `fn_extensions_set_switch` nunca rodou.
- **Sabotagens previstas, não rodadas.** Tirar `(profile = 'connected') = (entrada tem service_origin)`
  (esperado: o caso "declarative com service_origin" fica vermelho); tirar o incremento de revisão em
  `fn_extensions_set_switch` (esperado: o caso de revisão velha fica vermelho). Ficam para o CI.
- **Jornada J68 não executada.** O caso J68.1 está bloqueado: `experiments/extensoes/catalog/catalog.py`
  recusa perfil diferente de `declarative` (linha 168) e não grava `service_origin` (linha 353).
- **Reinstalar mantendo o desligado** (J68.8) foi lido no código, não testado.
- **Tela de extensões** não foi vista por nenhum navegador.
- **Comentário em `app/admin/(protected)/extensoes/page.tsx` (linha 153)** diz que ligar e desligar "se
  faz na tela da empresa". O código mostra o botão só na tela de administração da instalação. Pode ser
  comentário antigo; não foi alterado nesta entrega.
- **Espelho `.claude/skills` não regenerado** (ver acima).
- **Spec 33 não está nesta branch.** A emenda da F1 (remover "a versão da API do host sobe") é feita
  no outro PR, junto com a spec.
