/**
 * AS DUAS FRASES que a tela de `/admin/email` mostra quando o salvamento é
 * recusado — em um lugar só, longe do `"use server"`.
 *
 * Mesma razão de `lib/auth/recusa-de-escrita-de-admin.ts`: o arquivo da action
 * só pode exportar função assíncrona (é `"use server"`), então as frases que
 * TESTE e TELA citam moram aqui — se morassem lá, o teste as repetiria por
 * cópia e as duas cópias divergiriam no primeiro ajuste de texto.
 *
 * ─── Por que a frase é a chave de tradução ──────────────────────────────────
 *
 * A regra do dicionário deste repo é "a chave é o texto em português". O
 * formulário faz `toast.error(t(r.error))`, então estas frases são chaves: as
 * duas têm entrada em espanhol (`lib/i18n/dicionario.ts`), e quem opera em
 * espanhol lê a explicação, não o português.
 *
 * ─── O que cada uma responde ────────────────────────────────────────────────
 *
 * `endereco` — o formato que o banco aceita, dito a quem digita. O CHECK
 * `platform_smtp_settings_host` (issue #2804) recusava o endereço DEPOIS da
 * gravação e o toast mostrava o nome da constraint; agora a régua vale antes, e
 * o texto diz o que fazer com o nome de contêiner Docker, que é o caso real que
 * produziu o relato.
 *
 * `gravacao` — a falha que não é de formato (banco fora, privilégio, disquete
 * cheio) sem repetir a mensagem crua do Postgres, que nomeia tabela e
 * constraint e não ajuda quem opera.
 */
export const MENSAGEM_DA_RECUSA_DO_SMTP = {
  endereco:
    "O endereço do servidor aceita só letras, números, pontos e hífens, até 253 caracteres, começando com letra ou número. Não use sublinhado no nome — se ele é o nome de um contêiner Docker, use o endereço IP dele ou um apelido sem sublinhado. Também não use smtp:// na frente nem a porta no fim.",
  gravacao:
    "Não foi possível gravar o servidor de e-mail, e nada foi alterado. Confira os dados e tente de novo; se o problema continuar, fale com o suporte.",
} as const;
