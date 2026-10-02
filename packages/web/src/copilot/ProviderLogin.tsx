import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CopilotProvider, ProviderLogin } from "@argelanderspace/contracts";
import { answerProviderLogin, cancelProviderLogin, fetchProviderLogin, fetchProviders, ProviderApiError, startProviderLogin } from "../api/providers";
import { Button } from "../ui";

const isActive = (login: ProviderLogin | null) => login?.status === "running" || login?.status === "awaiting_user";
const safeLink = (url: string) => { try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; } };

/** openai-codex sign-in. The server owns the flow; this view only follows one login instance. */
export function OAuthLogin({ provider, onProvider, onChange, onLogout }: {
  provider: CopilotProvider; onProvider: (provider: CopilotProvider) => void; onChange: () => void; onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [login, setLogin] = useState<ProviderLogin | null>(provider.login ?? null);
  const [problem, setProblem] = useState<"start" | "busy" | "answer" | "refresh" | null>(null);
  const [working, setWorking] = useState(false);
  const [code, setCode] = useState("");
  // The instance this view follows; a reply for any other instance is ignored.
  const followed = useRef<string | null>(login?.id ?? null);
  const latest = useRef<ProviderLogin | null>(login);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const adopt = (next: ProviderLogin | null) => { latest.current = next; followed.current = next?.id ?? null; setLogin(next); };
  useEffect(() => { if (!provider.login) adopt(null); }, [provider.login]);
  const refresh = async () => {
    try {
      const result = await fetchProviders(); const next = result.providers.find((item) => item.id === provider.id);
      if (alive.current && next) { setProblem(null); onProvider(next); }
    } catch { if (alive.current) setProblem("refresh"); }
  };
  const apply = (next: ProviderLogin) => {
    if (!alive.current || followed.current !== next.id) return;
    const previous = latest.current;
    latest.current = next; setLogin(next);
    if (previous?.id === next.id && previous.status !== next.status && !isActive(next)) { onChange(); if (next.status === "succeeded") void refresh(); }
    if (next.challenge?.kind !== "manual_code") setCode("");
  };
  const lost = (reason: unknown) => {
    if (reason instanceof ProviderApiError && reason.code === "not_found") adopt(null);
  };
  useEffect(() => {
    if (!login || !isActive(login)) return;
    const controller = new AbortController(); const id = login.id;
    const timer = setInterval(() => {
      fetchProviderLogin(provider.id, id, controller.signal).then((result) => apply(result.login), (reason) => { if (!controller.signal.aborted) lost(reason); });
    }, 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [login?.id, login?.status, login?.challenge?.id]);
  const run = async (action: () => Promise<ProviderLogin>, failure: "start" | "answer") => {
    if (working) return;
    setWorking(true); setProblem(null);
    try { apply(await action()); }
    catch (reason) {
      if (reason instanceof ProviderApiError && reason.code === "busy") setProblem("busy");
      else setProblem(failure);
      if (failure === "answer" && login) void fetchProviderLogin(provider.id, login.id).then((result) => apply(result.login), lost);
    } finally { if (alive.current) setWorking(false); }
  };
  const start = () => { onChange(); setCode(""); void run(async () => { const result = await startProviderLogin(provider.id); adopt(result.login); return result.login; }, "start"); };
  const answer = (value: string) => { if (login?.challenge) { const challengeId = login.challenge.id; const id = login.id; void run(async () => (await answerProviderLogin(provider.id, id, challengeId, value)).login, "answer"); } };
  const cancel = () => {
    if (!login || working) return; const id = login.id;
    setWorking(true);
    cancelProviderLogin(provider.id, id).then((result) => apply(result.login), lost).finally(() => { if (alive.current) setWorking(false); onChange(); });
  };
  const active = isActive(login);
  const authUrl = login?.notices.find((notice) => notice.type === "auth_url");
  const deviceCode = login?.notices.find((notice) => notice.type === "device_code");
  const authLink = authUrl?.type === "auth_url" ? safeLink(authUrl.url) : null;
  const deviceLink = deviceCode?.type === "device_code" ? safeLink(deviceCode.verificationUri) : null;
  const stored = provider.credential.stored;
  const challenge = login?.challenge ?? null;
  return <div className="provider-login" data-ui="provider-oauth">
    <p className="provider-hint" data-ui="provider-login-state">{stored ? t("providers.login.signedIn") : t("providers.login.signedOut")}</p>
    {provider.credential.stored && provider.catalogStatus === "error" && <p role="alert" className="provider-error" data-ui="provider-catalog-error">{t("providers.login.catalogError")}</p>}
    {provider.credential.refreshFailed && <p role="alert" className="provider-error" data-ui="provider-refresh-failed">{t("providers.login.refreshFailed")}</p>}
    <div className="provider-actions">
      <Button disabled={active || working} busy={working && !active && !login} onClick={start} data-ui="provider-login-start">{stored ? t("providers.login.signInAgain") : t("providers.login.signIn")}</Button>
      <Button disabled={!stored} onClick={onLogout} data-ui="provider-logout">{t("providers.login.signOut")}</Button>
      <small>{t("providers.privateFile")}</small>
    </div>
    {problem && <p role="alert" className="provider-error" data-ui="provider-login-problem">{t(`providers.login.problems.${problem}`)}</p>}
    {login && <div className="provider-login-panel" data-ui="provider-login-panel" data-status={login.status}>
      {active && challenge?.kind === "select" && <div role="group" aria-label={t("providers.login.chooseMethod")} className="provider-actions" data-ui="provider-login-methods">
        <strong>{t("providers.login.chooseMethod")}</strong>
        {challenge.options.map((option) => <Button key={option.id} disabled={working} data-ui={`provider-login-method-${option.id}`} onClick={() => answer(option.id)}>{t(`providers.login.methods.${option.id}`, { defaultValue: t("providers.login.methodOther") })}</Button>)}
      </div>}
      {active && authLink && <p><a href={authLink} target="_blank" rel="noopener noreferrer" data-ui="provider-login-link">{t("providers.login.openPage")}</a></p>}
      {active && deviceCode?.type === "device_code" && <div data-ui="provider-login-device">
        <p>{t("providers.login.deviceHint")}</p>
        <p><code className="provider-user-code" data-ui="provider-login-code">{deviceCode.userCode}</code></p>
        {deviceLink && <p><a href={deviceLink} target="_blank" rel="noopener noreferrer" data-ui="provider-login-link">{t("providers.login.openVerification")}</a></p>}
      </div>}
      {active && challenge?.kind === "manual_code" && <form className="provider-login-form" onSubmit={(event) => { event.preventDefault(); if (code.trim()) answer(code.trim()); }}>
        <label className="provider-field">{t("providers.login.pasteLabel")}
          <input type="password" autoComplete="off" spellCheck={false} value={code} data-ui="provider-login-code-input" onChange={(event) => setCode(event.target.value)} />
        </label>
        <small>{t("providers.login.browserHint")}</small>
        <div className="provider-actions"><Button type="submit" disabled={working || !code.trim()} data-ui="provider-login-submit">{t("providers.login.submit")}</Button></div>
      </form>}
      <div role="status" className={login.status === "succeeded" ? "provider-success" : active ? "provider-hint" : "provider-error"} data-ui="provider-login-status">
        {active ? (challenge ? t("providers.login.awaiting") : t("providers.login.waiting")) : login.status === "failed" ? t(`providers.login.failed.${login.failure ?? "unavailable"}`) : t(`providers.login.${login.status as "succeeded" | "cancelled" | "expired"}`)}
      </div>
      {active && <div className="provider-actions"><Button disabled={working} onClick={cancel} data-ui="provider-login-cancel">{t("providers.login.cancel")}</Button></div>}
    </div>}
  </div>;
}
