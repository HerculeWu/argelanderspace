import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "../lib/icons";
import { IconButton } from "./IconButton";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface DialogProps {
  title: string;
  description?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

function focusableElements(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
  );
}

function canReceiveInitialFocus(element: HTMLElement | null | undefined) {
  return Boolean(element?.isConnected && !element.hasAttribute("disabled"));
}

/** Accessible modal shell: naming, focus containment/return, Escape/backdrop close, and busy close protection. */
export function Dialog({
  title,
  description,
  closeLabel,
  onClose,
  children,
  footer,
  width = 480,
  busy = false,
  initialFocusRef,
}: DialogProps) {
  const titleId = `dialog-title-${useId().replace(/:/g, "")}`;
  const descriptionId = `dialog-description-${useId().replace(/:/g, "")}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  const wasBusyRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const initialTarget = initialFocusRef?.current;
    if (canReceiveInitialFocus(initialTarget)) initialTarget?.focus();
    else if (!dialog.contains(document.activeElement)) dialog.focus();

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (activeIndex < 0) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && activeIndex === 0) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onDocumentFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      const safeTarget = busyRef.current ? null : initialFocusRef?.current;
      if (canReceiveInitialFocus(safeTarget)) safeTarget?.focus();
      else dialog.focus();
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    document.addEventListener("focusin", onDocumentFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("focusin", onDocumentFocusIn, true);
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [initialFocusRef]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (busy) {
      dialog.focus();
    } else if (wasBusyRef.current) {
      const safeTarget = initialFocusRef?.current;
      if (canReceiveInitialFocus(safeTarget)) safeTarget?.focus();
      else dialog.focus();
    }
    wasBusyRef.current = busy;
  }, [busy, initialFocusRef]);

  const requestClose = () => {
    if (!busyRef.current) onCloseRef.current();
  };

  return createPortal(
    <div
      className="ui-dialog-overlay plan-modal-overlay"
      data-testid="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="ui-dialog plan-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        style={{ "--dialog-width": `${width}px` } as CSSProperties}
      >
        <div className="ui-dialog-head plan-modal-head">
          <div className="ui-dialog-titles plan-modal-titles">
            <h2 id={titleId} className="ui-dialog-title plan-modal-title">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="ui-dialog-description plan-modal-sub">
                {description}
              </div>
            )}
          </div>
          <IconButton
            label={closeLabel}
            icon={<Icon name="x" cls="ico-sm" />}
            variant="ghost"
            disabled={busy}
            onClick={requestClose}
          />
        </div>
        <div className="ui-dialog-body plan-modal-body">{children}</div>
        {footer && <div className="ui-dialog-foot plan-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
