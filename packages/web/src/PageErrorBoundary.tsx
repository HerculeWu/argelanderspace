import { Component, type ErrorInfo, type ReactNode } from "react";
import { withTranslation, type WithTranslation } from "react-i18next";
import { Icon } from "./lib/icons";
import { currentPaneName, errorNameOf, reportPageError, type PageErrorOutcome } from "./page-errors";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** What "Reload" does; by default the whole page is loaded again at the address it has. */
  reload?: () => void;
}

interface State {
  /** Set while the fallback is shown: the class name of what was thrown and the pane it happened in. */
  failure: { name: string; pane: string } | null;
  /** Whether the error reached the log; `pending` until the server has answered. */
  logged: PageErrorOutcome | "pending";
}

const reloadPage = (): void => window.location.reload();
// The two sentences about the log. Both are always laid out, one on top of the other, and at most one is visible:
// the place the sentence takes is the same before and after the server's answer, in every language and width.
const LOG_SENTENCES = [
  ["recorded", "pageError.recorded"],
  ["not_recorded", "pageError.notRecorded"],
] as const;

/**
 * The page's top-level error boundary: a render error shows a notice that can be recovered from instead of a blank
 * page. It names the error's class and the pane, never the error's message, and says whether the error reached the
 * log. "Reload" loads the whole page again (the address stays): state held in modules, which mounting the page anew
 * would keep, starts over too, and a desktop window has no reload key of its own.
 */
class Boundary extends Component<Props & WithTranslation, State> {
  state: State = { failure: null, logged: "pending" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failure: { name: errorNameOf(error), pane: currentPaneName() }, logged: "pending" };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    void reportPageError("render", error).then((logged) => this.setState({ logged }));
  }

  // Called when the button is put into the page, that is, when the notice appears. The workbench, and whatever had
  // the keyboard in it, is gone: the keyboard goes to the one thing there is to do. (The notice is an alert, so a
  // screen reader reads its text wherever the focus is.)
  private focusReload = (button: HTMLButtonElement | null): void => {
    button?.focus();
  };

  render(): ReactNode {
    const { failure, logged } = this.state;
    const { t } = this.props;
    if (failure === null) return this.props.children;
    return (
      <div className="page-error" data-ui="page-error" role="alert">
        <div className="page-error-card">
          <Icon name="triangle-alert" cls="ico-lg" aria-hidden="true" />
          <h1 className="page-error-title">{t("pageError.title")}</h1>
          <p className="page-error-status" data-ui="page-error-status" data-logged={logged}>
            {LOG_SENTENCES.map(([outcome, key]) => (
              <span key={outcome} data-variant={outcome} aria-hidden={logged === outcome ? undefined : "true"}>
                {t(key)}
              </span>
            ))}
          </p>
          <p data-ui="page-error-hint">{t("pageError.reloadHint")}</p>
          <dl className="page-error-facts">
            <dt>{t("pageError.name")}</dt>
            <dd><code data-ui="page-error-name">{failure.name}</code></dd>
            <dt>{t("pageError.pane")}</dt>
            <dd><code data-ui="page-error-pane">{failure.pane}</code></dd>
          </dl>
          <div className="page-error-actions">
            <Button ref={this.focusReload} appearance="primary" data-ui="page-error-reload" onClick={this.props.reload ?? reloadPage}>
              {t("pageError.reload")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export const PageErrorBoundary = withTranslation()(Boundary);
