"use client";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";
import { amigoRequest, AmigoUiError, errorText, read } from "./_api";
import { useLoad } from "./_hooks";
import { Field, Notice, Panel, Pick, options } from "./_ui";
import type { AmigoSafeConfig, Named } from "./_types";
export function AmigoConfig({
  config,
  canConfigure,
  onChange,
}: {
  config: AmigoSafeConfig;
  canConfigure: boolean;
  onChange: (value: AmigoSafeConfig) => void;
}) {
  const [token, setToken] = useState("");
  const [tested, setTested] = useState(false);
  const [places, setPlaces] = useState<Named[] | null>(null);
  const [place, setPlace] = useState(String(config.default_place_id ?? ""));
  const [timezone, setTimezone] = useState(config.timezone);
  const [active, setActive] = useState(config.active);
  const [sameDay, setSameDay] = useState(
    config.allow_same_day === undefined ? "" : String(config.allow_same_day),
  );
  const [months, setMonths] = useState(String(config.months_ahead ?? ""));
  const [reminders, setReminders] = useState(config.reminders_enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [disconnect, setDisconnect] = useState(false);
  const lock = useRef(false);
  const loadPlaces = useCallback(() => read<Named[]>("places"), []);
  const savedPlaces = useLoad(loadPlaces, canConfigure && config.configured && !token);
  const test = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    setMessage("");
    setTested(false);
    try {
      const result = await amigoRequest<{ valid: boolean; places: Named[] }>(
        "/test",
        "POST",
        token.trim() ? { token: token.trim() } : {},
      );
      if (result.valid !== true || !Array.isArray(result.places))
        throw new AmigoUiError("invalid_response");
      setTested(true);
      setPlaces(result.places);
      setMessage("Conexão validada. Confira a unidade antes de salvar.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
      lock.current = false;
    }
  };
  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const result = await amigoRequest<AmigoSafeConfig>("", "PUT", {
        ...(token.trim() ? { token: token.trim() } : {}),
        active,
        ...(place ? { default_place_id: Number(place) } : {}),
        timezone,
        allow_same_day: sameDay ? sameDay === "true" : null,
        months_ahead: months ? Number(months) : null,
        reminders_enabled: reminders,
      });
      onChange(result);
      setToken("");
      setTested(false);
      setPlaces(null);
      setActive(result.active);
      setPlace(String(result.default_place_id ?? ""));
      setMessage(
        result.active
          ? "Configuração salva. Amigo é a agenda principal."
          : "Configuração salva. Confira unidade e fuso e ative a agenda em uma ação separada.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
      lock.current = false;
    }
  };
  const remove = async () => {
    setPending(true);
    setError("");
    try {
      await amigoRequest("", "DELETE");
      onChange({
        ...config,
        configured: false,
        active: false,
        connection_id: null,
        token_last4: null,
        validated_at: null,
        default_place_id: null,
        reminders_enabled: false,
      });
      setToken("");
      setPlace("");
      setPlaces(null);
      setActive(false);
      setReminders(false);
      setDisconnect(false);
      setMessage("Conexão removida. O histórico foi preservado.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel
      title="Conexão da clínica"
      description="Conecte o Amigo para consultar pacientes e operar a agenda da sua clínica."
    >
      {!config.configured && (
        <div className="rounded-md border border-dashed p-5">
          <h2 className="font-medium">Conecte sua clínica quando estiver pronto</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A integração é opcional. Peça o token de acesso à sua clínica e configure por aqui.
          </p>
        </div>
      )}
      {config.configured && (
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Token salvo</dt>
            <dd>•••• {config.token_last4}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Validado em</dt>
            <dd>
              {config.validated_at
                ? new Date(config.validated_at).toLocaleString("pt-BR", {
                    timeZone: config.timezone,
                  })
                : "Ainda não validado"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Modo da agenda</dt>
            <dd>
              {config.active
                ? "Amigo como agenda principal"
                : "Integração disponível para consulta"}
            </dd>
          </div>
        </dl>
      )}
      {!canConfigure ? (
        <p className="text-sm text-muted-foreground">
          Um administrador configura a conexão e o modo da agenda. Você pode consultar as outras
          abas.
        </p>
      ) : (
        <>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Token Amigo">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  disabled={pending}
                  placeholder={
                    config.configured
                      ? "Deixe em branco para manter o token salvo"
                      : "Cole o token de acesso"
                  }
                  onChange={(e) => {
                    setToken(e.target.value);
                    setTested(false);
                    setMessage("");
                    setPlaces(null);
                    setPlace("");
                    setActive(false);
                  }}
                />
              </Field>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void test()}
                  disabled={pending || (!token.trim() && !config.configured)}
                >
                  Testar conexão
                </Button>
              </div>
              <Pick
                label="Unidade padrão"
                value={place}
                required={active}
                disabled={pending}
                onChange={(e) => setPlace(e.target.value)}
                options={options(places ?? savedPlaces.data)}
              />
              <Pick
                label="Fuso da clínica"
                value={timezone}
                disabled={pending}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder=""
                options={[
                  ...FUSOS_OFERECIDOS,
                  ...(!FUSOS_OFERECIDOS.some((f) => f.codigo === timezone)
                    ? [{ codigo: timezone, rotulo: timezone }]
                    : []),
                ].map((f) => ({ value: f.codigo, label: f.rotulo }))}
              />
              <Pick
                label="Ofertar vagas de hoje"
                value={sameDay}
                disabled={pending}
                placeholder="Usar regra da clínica no Amigo"
                onChange={(e) => setSameDay(e.target.value)}
                options={[
                  { value: "true", label: "Permitir" },
                  { value: "false", label: "Não permitir" },
                ]}
              />
              <Pick
                label="Oferta de datas futuras"
                value={months}
                disabled={pending}
                placeholder="Usar regra da clínica no Amigo"
                onChange={(e) => setMonths(e.target.value)}
                options={[
                  { value: "3", label: "Até 3 meses" },
                  { value: "6", label: "Até 6 meses" },
                ]}
              />
            </div>
            <label className="flex items-start gap-3 rounded-md border p-4 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={active}
                disabled={pending || !!token.trim() || !config.configured || !config.validated_at}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span>
                <span className="font-medium">Usar Amigo como agenda principal</span>
                <span className="mt-1 block text-muted-foreground">
                  Salve o token primeiro. Depois confira unidade e fuso e ative a agenda.
                  Compromissos anteriores mantêm sua origem.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={reminders}
                disabled={pending}
                onChange={(e) => setReminders(e.target.checked)}
              />
              <span>
                Enviar lembretes para consultas Amigo
                <span className="mt-1 block text-muted-foreground">
                  Desligado por padrão. Confira os avisos já enviados pelo Amigo para evitar
                  mensagens duplicadas. É preciso vincular paciente, destinatário e tipo de
                  atendimento.
                </span>
              </span>
            </label>
            <Notice error={error || savedPlaces.error} loading={pending || savedPlaces.loading} />
            {message && (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
            <Button
              disabled={
                pending ||
                (!!token.trim() && !tested) ||
                (!config.configured && !tested) ||
                (active && !place)
              }
            >
              Salvar configuração
            </Button>
          </form>
          {config.configured && (
            <div className="border-t pt-4">
              {!disconnect ? (
                <Button variant="outline" onClick={() => setDisconnect(true)}>
                  Desconectar Amigo
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm">
                    Desconectar impede novas operações e preserva o histórico.
                  </p>
                  <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
                    Confirmar desconexão
                  </Button>
                  <Button variant="ghost" disabled={pending} onClick={() => setDisconnect(false)}>
                    Manter conexão
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
