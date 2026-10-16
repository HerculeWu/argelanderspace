import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderModelConfigSchema, type CopilotModel, type CopilotProvider, type ProviderModelConfig, type ProviderTestCode, type ThinkingLevel } from "@argelanderspace/contracts";
import { fetchProviders, logoutProvider, removeProviderKey, saveProviderConfig, saveProviderKey, testProviderConnection, ProviderApiError } from "../api/providers";
import { Badge, Button, Dialog, Select } from "../ui";
import { OAuthLogin } from "./ProviderLogin";
import "./providers.css";

export function ProviderSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<CopilotProvider[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const changeBusy = (value: boolean) => {
    if (value && busyRef.current) return false;
    busyRef.current = value; setBusy(value); return true;
  };
  const load = async () => {
    const current = ++generation.current;
    setFailed(false);
    try {
      const result = await fetchProviders();
      if (current === generation.current) setProviders(result.providers.sort((a, b) => {
        const rank = (id: string) => id === "openai" ? 0 : id === "openai-codex" ? 1 : 2;
        return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
      }));
    } catch { if (current === generation.current) setFailed(true); }
  };
  useEffect(() => { void load(); return () => { generation.current++; }; }, []);
  return <Dialog title={t("providers.title")} closeLabel={t("providers.close")} onClose={onClose} uiId="provider-settings" width={620} busy={busy} initialFocusRef={closeRef}
    footer={<Button ref={closeRef} disabled={busy} onClick={onClose}>{t("providers.close")}</Button>}>
    <div className="provider-settings">
      {failed ? <div role="alert" data-ui="provider-load-error">{t("providers.loadError")} <Button onClick={() => void load()}>{t("providers.retry")}</Button></div> : !providers ? <p role="status">{t("providers.loading")}</p> : providers.length === 0 ? <p>{t("providers.empty")}</p> : providers.map((provider) =>
        <ProviderCard key={provider.id} provider={provider} onBusy={changeBusy} globalBusy={busy} initiallyOpen={provider.id === "openai" || provider.id === "openai-codex"} />)}
    </div>
  </Dialog>;
}

function modelConfig(model: CopilotModel): ProviderModelConfig {
  return { baseUrl: model.baseUrl, modelId: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, image: model.image, tools: model.tools, defaultThinking: model.defaultThinking };
}

function ProviderCard({ provider: initial, onBusy, globalBusy, initiallyOpen }: { provider: CopilotProvider; onBusy: (busy: boolean) => boolean; globalBusy: boolean; initiallyOpen: boolean }) {
  const uid = useId();
  const { t } = useTranslation();
  const [provider, setProvider] = useState(initial);
  const [key, setKey] = useState("");
  const [config, setConfig] = useState<ProviderModelConfig>(() => modelConfig(initial.models[0]));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "signed_out" | "error" | "storage" | "capabilities" | "catalog_error">("idle");
  const [check, setCheck] = useState<ProviderTestCode | "idle" | "checking">("idle");
  const testRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const invalidate = () => { generation.current++; testRef.current?.abort(); testRef.current = null; setCheck("idle"); };
  useEffect(() => () => { generation.current++; testRef.current?.abort(); }, []);
  const selected = provider.models.find((model) => model.id === config.modelId);
  const levels = selected?.capabilitiesKnown && selected.baseUrl === config.baseUrl ? selected.thinkingLevels : [];
  const validThinking = config.defaultThinking === null || levels.includes(config.defaultThinking);
  const editableThinking = levels.length > 1 || !validThinking;
  const valid = ProviderModelConfigSchema.safeParse(config).success && validThinking;
  const update = (patch: Partial<ProviderModelConfig>) => {
    invalidate(); setSaveState("idle"); setConfig((previous) => ({ ...previous, ...patch }));
  };
  const selectModel = (id: string) => {
    const model = provider.models.find((item) => item.id === id);
    update(model ? modelConfig(model) : { modelId: id, defaultThinking: null });
  };
  const mutate = async (action: "key" | "remove" | "config" | "logout") => {
    if (busyRef.current || !onBusy(true)) return;
    busyRef.current = true; setBusy(true); invalidate(); setSaveState("idle");
    try {
      const result = action === "key" ? await saveProviderKey(provider.id, key) : action === "remove" ? await removeProviderKey(provider.id) : action === "logout" ? await logoutProvider(provider.id) : await saveProviderConfig(provider.id, config);
      setProvider(result.provider);
      if (action !== "config") setKey("");
      setSaveState(result.provider.catalogStatus === "error" ? "catalog_error" : action === "logout" ? "signed_out" : "saved");
    } catch (error) {
      setSaveState(error instanceof ProviderApiError && (error.code === "storage" || error.code === "capabilities") ? error.code : "error");
    } finally { busyRef.current = false; setBusy(false); onBusy(false); }
  };
  const test = async () => {
    invalidate(); const current = generation.current; const controller = new AbortController(); testRef.current = controller; setCheck("checking");
    try {
      const result = await testProviderConnection(provider.id, config, controller.signal);
      if (generation.current === current) { setCheck(result.code); testRef.current = null; }
    } catch {
      if (generation.current === current) { setCheck(controller.signal.aborted ? "cancelled" : "unavailable"); testRef.current = null; }
    }
  };
  const cancel = () => { invalidate(); setCheck("cancelled"); };
  return <details className="provider-card" open={initiallyOpen} data-ui="provider-card" data-ui-key={provider.id}>
    <summary className="provider-heading"><strong>{provider.name}</strong><span>{provider.method === "api_key" ? t("providers.apiKey") : t("providers.loginMethod")}</span><Badge>{t(`providers.sources.${provider.credential.source}`)}</Badge></summary>
    <fieldset disabled={busy || globalBusy}>
      {provider.method === "api_key" ? <>
        <label className="provider-field">{t("providers.apiKey")}<input type="password" autoComplete="off" spellCheck={false} value={key} data-ui="provider-api-key" aria-label={`${provider.name} ${t("providers.apiKey")}`} onChange={(event) => { invalidate(); setSaveState("idle"); setKey(event.target.value); }} /></label>
        <div className="provider-actions"><Button disabled={!key.trim()} onClick={() => void mutate("key")} data-ui="provider-save-key">{provider.credential.stored ? t("providers.replaceKey") : t("providers.saveKey")}</Button><Button disabled={!provider.credential.stored} onClick={() => void mutate("remove")} data-ui="provider-remove-key">{t("providers.remove")}</Button><small>{t("providers.privateFile")}</small></div>
      </> : <OAuthLogin provider={provider} onLogout={() => void mutate("logout")}
        onChange={() => { invalidate(); setSaveState("idle"); }}
        onProvider={(next) => { setProvider(next); setSaveState(next.catalogStatus === "error" ? "catalog_error" : "idle"); }} />}
      <details className="provider-advanced" data-ui={`provider-advanced-${provider.id}`}>
        <summary>{t("providers.advanced")}</summary>
        <label className="provider-field" htmlFor={`${uid}-model`}>{t("providers.model")}<Select id={`${uid}-model`} data-ui="provider-model" aria-label={t("providers.model")} value={selected ? selected.id : ""} onChange={selectModel} options={[...(selected ? [] : [{ value: "", label: t("providers.customModel") }]), ...provider.models.map((model) => ({ value: model.id, label: model.name }))]} /></label>
        <label className="provider-field">{t("providers.baseUrl")}<input value={config.baseUrl} data-ui="provider-base-url" onChange={(event) => update({ baseUrl: event.target.value })} /></label>
        <label className="provider-field">{t("providers.modelId")}<input value={config.modelId} data-ui="provider-model-id" onChange={(event) => selectModel(event.target.value)} /></label>
        <label className="provider-field">{t("providers.name")}<input value={config.name} data-ui="provider-model-name" onChange={(event) => update({ name: event.target.value })} /></label>
        <div className="provider-columns">
          <label className="provider-field">{t("providers.context")}<input type="number" min={1} value={config.contextWindow} data-ui="provider-context" onChange={(event) => update({ contextWindow: Number(event.target.value) })} /></label>
          <label className="provider-field">{t("providers.output")}<input type="number" min={1} value={config.maxTokens} data-ui="provider-output" onChange={(event) => update({ maxTokens: Number(event.target.value) })} /></label>
        </div>
        <div className="provider-capabilities"><label><input type="checkbox" checked={config.image} data-ui="provider-image" onChange={(event) => update({ image: event.target.checked })} />{t("providers.image")}</label><label><input type="checkbox" checked={config.tools} data-ui="provider-tools" onChange={(event) => update({ tools: event.target.checked })} />{t("providers.tools")}</label></div>
        <label className="provider-field" htmlFor={`${uid}-thinking`}>{t("providers.defaultThinking")}<Select id={`${uid}-thinking`} data-ui={`provider-default-thinking-${provider.id}`} aria-label={t("providers.defaultThinking")} disabled={!editableThinking} value={config.defaultThinking ?? ""} onChange={(next) => update({ defaultThinking: next === "" ? null : next as ThinkingLevel })} options={[
          { value: "", label: levels.length === 0 ? t("providers.unknownCapabilities") : levels.length === 1 ? t("providers.noThinking") : t("providers.sdkDefault") },
          ...(!validThinking ? [{ value: config.defaultThinking!, label: t("providers.invalidThinking") }] : []),
          ...(editableThinking ? levels.map((level) => ({ value: level, label: t(`providers.levels.${level}`) })) : []),
          ...(levels.length === 1 && config.defaultThinking === "off" ? [{ value: "off", label: t("providers.noThinking") }] : []),
        ]} /></label>
        {!validThinking && <p role="alert" className="provider-error">{t("providers.invalidThinking")}</p>}
        <p className="provider-hint">{levels.length === 0 ? t("providers.unknownCapabilities") : t("providers.defaultHint")}</p>
        <div className="provider-actions"><Button disabled={!valid} data-ui={`provider-save-config-${provider.id}`} onClick={() => void mutate("config")}>{t("providers.saveConfig")}</Button><Button disabled={!valid || check === "checking"} busy={check === "checking"} data-ui={`provider-test-${provider.id}`} onClick={() => void test()}>{t("providers.test")}</Button>{check === "checking" && <Button data-ui="provider-cancel-test" onClick={cancel}>{t("providers.cancel")}</Button>}</div>
        <div role="status" className={`provider-test-state ${check === "success" ? "provider-success" : check !== "idle" && check !== "checking" ? "provider-error" : ""}`} data-ui={`provider-test-result-${provider.id}`}>{t(`providers.tests.${check}`)}</div>
      </details>
      {saveState !== "idle" && <p role={saveState === "saved" || saveState === "signed_out" ? "status" : "alert"} data-ui="provider-save-result" className={saveState === "saved" || saveState === "signed_out" ? "provider-success" : "provider-error"}>{t(`providers.saves.${saveState}`)}</p>}
    </fieldset>
  </details>;
}
