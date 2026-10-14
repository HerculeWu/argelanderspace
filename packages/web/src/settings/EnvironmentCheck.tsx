import type {
  EnvironmentFeature,
  EnvironmentReport,
  EnvironmentTool,
  KeychainReason,
  ToolSource,
} from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchEnvironment } from "../api/environment";
import { Icon } from "../lib/icons";
import { ActionButton, InlineMessage } from "../ui";

/**
 * The environment check of the "TeX & environment" group (desktop-app ticket 13), as in the approved prototype: one row
 * per program — found or not; when found its version line and where it is (with the step of the lookup that found it);
 * when missing what is unavailable without it — and a row for the system keychain. Below: a warning when TeX was not
 * found, and the no-sandbox note (the Copilot does not cause compiles here; Render pressed by the user still compiles).
 */

const SOURCE_LABEL = {
  tex_dir: "settings.tex.source.tex_dir",
  path: "settings.tex.source.path",
  common: "settings.tex.source.common",
} as const satisfies Record<ToolSource, string>;
const FEATURE_LABEL = {
  latex_ingest: "settings.tex.feature.latex_ingest",
  writer_render: "settings.tex.feature.writer_render",
  pdflatex: "settings.tex.feature.pdflatex",
  xelatex: "settings.tex.feature.xelatex",
  bibtex: "settings.tex.feature.bibtex",
  biber: "settings.tex.feature.biber",
  figures: "settings.tex.feature.figures",
  eps_figures: "settings.tex.feature.eps_figures",
  copilot_compile: "settings.tex.feature.copilot_compile",
} as const satisfies Record<EnvironmentFeature, string>;
const KEYCHAIN_REASON_LABEL = {
  secret_service: "settings.tex.keychainReason.secret_service",
  activatable: "settings.tex.keychainReason.activatable",
  platform: "settings.tex.keychainReason.platform",
  no_bus: "settings.tex.keychainReason.no_bus",
  no_service: "settings.tex.keychainReason.no_service",
  no_module: "settings.tex.keychainReason.no_module",
  no_probe: "settings.tex.keychainReason.no_probe",
} as const satisfies Record<KeychainReason, string>;

/** The figure converters are optional: the ingest leaves the figures out without them. */
const OPTIONAL: ReadonlySet<EnvironmentTool> = new Set(["pdftocairo", "ghostscript"]);

export interface EnvironmentState {
  report: EnvironmentReport | null;
  /** A check is running (the first one, or "check again"). */
  checking: boolean;
  /** The last check got no answer. */
  failed: boolean;
  recheck: () => void;
}

/** The report, checked when the group opens, again on `recheck` and whenever `key` changes (the TeX directory saved). */
export function useEnvironment(key: unknown): EnvironmentState {
  const [report, setReport] = useState<EnvironmentReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const run = useCallback(() => {
    const mine = ++generation.current;
    setChecking(true);
    void fetchEnvironment().then((next) => {
      // A later check (or a closed group) wins: a late answer is dropped.
      if (mine !== generation.current) return;
      setChecking(false);
      setFailed(next === null);
      if (next !== null) setReport(next);
    });
  }, []);
  // A changed TeX directory (`key`) is a reason to check again.
  useEffect(() => {
    run();
    return () => {
      generation.current += 1;
    };
  }, [run, key]);
  return { report, checking, failed, recheck: run };
}

export function EnvironmentCheck({ state }: { state: EnvironmentState }) {
  const { t } = useTranslation();
  const { report, checking, failed } = state;
  const latexmk = report?.tools.find((tool) => tool.tool === "latexmk");
  return (
    <section className="st-env" data-ui="environment-check" data-state={checking ? "checking" : "done"} aria-labelledby="env-h" aria-busy={checking}>
      <div className="st-sub-head">
        <h3 id="env-h">{t("settings.tex.envCheck")}</h3>
        <ActionButton
          mode="icon"
          iconName="refresh-cw"
          iconSize="small"
          tooltipAlign="end"
          data-ui="environment-recheck"
          label={t("settings.tex.recheck")}
          tooltip={t("settings.tex.recheck")}
          busy={checking}
          disabled={checking}
          onClick={state.recheck}
        />
      </div>
      {failed && (
        <InlineMessage tone="danger" uiId="environment-unreachable">{t("settings.tex.unreachable")}</InlineMessage>
      )}
      {report === null ? (
        checking && <p className="st-note" data-ui="environment-loading" role="status">{t("settings.tex.checking")}</p>
      ) : (
        <div className="st-table" role="list" aria-label={t("settings.tex.envCheck")}>
          {report.tools.map((tool) => (
            <div className="st-tr" role="listitem" key={tool.tool} data-ui="environment-tool" data-ui-key={tool.tool} data-found={tool.found}>
              <div className="st-td name">
                <code>{tool.tool}</code>
                {OPTIONAL.has(tool.tool) && <span className="st-opt">{t("settings.tex.optional")}</span>}
              </div>
              <div className="st-td state">
                {tool.found ? (
                  <span className="st-pill ok"><Icon name="check" cls="ico-sm" />{t("settings.tex.found")}</span>
                ) : (
                  <span className="st-pill warn"><Icon name="circle-alert" cls="ico-sm" />{t("settings.tex.notFound")}</span>
                )}
              </div>
              <div className="st-td detail">
                {tool.found ? (
                  <>
                    {tool.version !== null && <code className="st-ver" data-ui="environment-version">{tool.version}</code>}
                    <span className="st-where" data-ui="environment-location" data-source={tool.source ?? undefined}>
                      {t("settings.tex.foundAt")}
                      {tool.source !== null && <span className="st-from"> · {t(SOURCE_LABEL[tool.source])}</span>}
                      : <code className="st-path" title={tool.path?.path}>{tool.path?.display}</code>
                    </span>
                  </>
                ) : (
                  <span className="st-affects" data-ui="environment-affects">
                    {t("settings.tex.affects")}: {tool.affects.map((feature) => t(FEATURE_LABEL[feature])).join(t("settings.tex.listSeparator"))}
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="st-tr" role="listitem" data-ui="environment-tool" data-ui-key="keychain" data-found={report.keychain.state === "available"} data-state={report.keychain.state}>
            <div className="st-td name"><code>{t("settings.tex.keychain")}</code></div>
            <div className="st-td state">
              {report.keychain.state === "available" ? (
                <span className="st-pill ok"><Icon name="check" cls="ico-sm" />{t("settings.tex.available")}</span>
              ) : (
                <span className="st-pill warn"><Icon name="circle-alert" cls="ico-sm" />{report.keychain.state === "unknown" ? t("settings.tex.unknown") : t("settings.tex.unavailable")}</span>
              )}
            </div>
            <div className="st-td detail">
              <span className="st-where" data-ui="environment-keychain-reason">{t(KEYCHAIN_REASON_LABEL[report.keychain.reason])}</span>
              {report.keychain.state !== "available" && <span className="st-affects">{t("settings.tex.affects")}: {t("settings.tex.keychainAffects")}</span>}
            </div>
          </div>
        </div>
      )}
      {latexmk !== undefined && !latexmk.found && (
        <InlineMessage tone="warning" uiId="env-no-tex" title={t("settings.tex.noTexTitle")}>{t("settings.tex.noTexBody")}</InlineMessage>
      )}
      {report !== null && report.sandbox === "unavailable" && (
        <InlineMessage tone="info" uiId="env-no-sandbox" title={t("settings.tex.noSandboxTitle")}>{t("settings.tex.noSandboxBody")}</InlineMessage>
      )}
    </section>
  );
}
