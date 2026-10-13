import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { Icon } from "./lib/icons";
import { currentPaneName, errorNameOf, reportPageError, type PageErrorOutcome } from "./page-errors";
import { Button } from "./ui";

interface State {
  /** Set while the fallback is shown: the class name of what was thrown and the pane it happened in. */
  failure: { name: string; pane: string } | null;
  /** Whether the error reached the log; `pending` until the server has answered. */
  logged: PageErrorOutcome | "pending";
  /** Each reload mounts the page anew under a new key. */
  attempt: number;
}

/**
 * The page's top-level error boundary: a render error shows a notice that can be recovered from instead of a blank
 * page. It names the error's class and the pane, never the error's message, and says whether the error reached the
 * log. "Reload" mounts the page again from its saved state (no navigation: the address and what is saved stay).
 */
class Boundary extends Component<{ children: ReactNode } & WithTranslation, State> {
  state: State = { failure: null, logged: "pending", attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failure: { name: errorNameOf(error), pane: currentPaneName() }, logged: "pending" };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const attempt = this.state.attempt;
    void reportPageError("render", error).then((logged) => {
      // An answer that comes back after the page was reloaded says nothing about what is shown now.
      if (this.state.failure !== null && this.state.attempt === attempt) this.setState({ logged });
    });
  }

  private reload = (): void => {
    this.setState((state) => ({ failure: null, logged: "pending", attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    const { failure, logged, attempt } = this.state;
    const { t } = this.props;
    if (failure === null) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div className="page-error" data-ui="page-error" role="alert">
        <div className="page-error-card">
          <Icon name="triangle-alert" cls="ico-lg" aria-hidden="true" />
          <h1 className="page-error-title">{t("pageError.title")}</h1>
          <p data-ui="page-error-status" data-logged={logged}>
            {logged === "recorded" ? t("pageError.recorded") : logged === "not_recorded" ? t("pageError.notRecorded") : null}
            {logged === "pending" ? null : " "}
            {t("pageError.reloadHint")}
          </p>
          <dl className="page-error-facts">
            <dt>{t("pageError.name")}</dt>
            <dd><code data-ui="page-error-name">{failure.name}</code></dd>
            <dt>{t("pageError.pane")}</dt>
            <dd><code data-ui="page-error-pane">{failure.pane}</code></dd>
          </dl>
          <div className="page-error-actions">
            <Button appearance="primary" data-ui="page-error-reload" onClick={this.reload}>
              <Icon name="rotate-cw" cls="ico-sm" aria-hidden="true" />
              {t("pageError.reload")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export const PageErrorBoundary = withTranslation()(Boundary);
