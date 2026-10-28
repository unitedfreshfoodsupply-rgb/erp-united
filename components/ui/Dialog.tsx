"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLocale } from "@/lib/locale";

/**
 * Modal dialogs on the native <dialog> element, opened with showModal(): the browser
 * makes the page inert, contains focus, closes on Esc and returns focus to the control
 * that opened it — none of that is re-implemented here.
 *
 *   <Modal open={open} onClose={…} title="…">…</Modal>        — a dialog with your own content
 *   const dialogs = useDialogs();
 *   if (!(await dialogs.confirm({ title, body, tone: "danger" }))) return;
 *   const reason = await dialogs.prompt({ title, label, required: true });  // null = cancelled
 *
 * confirm()/prompt() replace window.confirm/window.prompt one for one: same question,
 * same result, but readable in both languages, styled, and keyboard/screen-reader friendly.
 */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** Selector inside the dialog to focus first (else the first [autofocus], else the dialog). */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const { t } = useLocale();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      if (initialFocus) d.querySelector<HTMLElement>(initialFocus)?.focus();
    } else if (!open && d.open) d.close();
  }, [open, initialFocus]);

  // Esc, the back gesture and our own close buttons all end in the native "close" event.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onNativeClose = () => onClose();
    d.addEventListener("close", onNativeClose);
    return () => d.removeEventListener("close", onNativeClose);
  }, [onClose]);

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md";
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={`w-[calc(100%-2rem)] ${width} rounded-2xl border border-united-border bg-white p-0 text-united-dark shadow-pop`}
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-3 px-5 pt-5">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-lg font-bold leading-snug">{title}</h2>
              {description && <div id={descId} className="text-sm text-united-muted">{description}</div>}
            </div>
            <button type="button" onClick={() => ref.current?.close()} className="-m-1 rounded-lg p-1.5 text-united-muted hover:bg-united-subtle" aria-label={t("ui.close")}>
              <X size={18} aria-hidden />
            </button>
          </div>
          {children && <div className="px-5 pt-4">{children}</div>}
          {footer && <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-united-border bg-united-bg/60 px-5 py-3 rounded-b-2xl">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

type Tone = "primary" | "danger";
type ConfirmOptions = { title: string; body?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: Tone };
type PromptOptions = ConfirmOptions & { label: string; placeholder?: string; required?: boolean; multiline?: boolean; initialValue?: string; inputDir?: "ltr" | "rtl" | "auto" };
type Request = { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void } | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

const DialogContext = createContext<{ confirm: (o: ConfirmOptions) => Promise<boolean>; prompt: (o: PromptOptions) => Promise<string | null> } | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  const answered = useRef(false);
  const { t } = useLocale();
  const inputId = useId();

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => { answered.current = false; setReq({ kind: "confirm", opts, resolve }); }), []);
  const prompt = useCallback((opts: PromptOptions) => new Promise<string | null>((resolve) => { answered.current = false; setValue(opts.initialValue ?? ""); setReq({ kind: "prompt", opts, resolve }); }), []);

  const finish = useCallback((result: boolean | string | null) => {
    setReq((cur) => {
      if (cur && !answered.current) {
        answered.current = true;
        if (cur.kind === "confirm") cur.resolve(result === true);
        else cur.resolve(typeof result === "string" ? result : null);
      }
      return null;
    });
  }, []);

  const opts = req?.opts;
  const danger = opts?.tone === "danger";
  const isPrompt = req?.kind === "prompt";
  const p = isPrompt ? (opts as PromptOptions) : null;
  const canSubmit = !p?.required || value.trim().length > 0;
  const submit = () => { if (canSubmit) finish(isPrompt ? value.trim() : true); };

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      <Modal
        open={!!req}
        onClose={() => finish(isPrompt ? null : false)}
        title={opts?.title ?? ""}
        description={opts?.body}
        size="sm"
        // Destructive confirmations start on the safe choice; prompts start in the field.
        initialFocus={isPrompt ? "[data-dialog-input]" : danger ? "[data-dialog-cancel]" : "[data-dialog-confirm]"}
        footer={
          <>
            <button type="button" data-dialog-cancel className="btn-secondary btn-sm" onClick={() => finish(isPrompt ? null : false)}>
              {opts?.cancelLabel ?? t("ui.cancel")}
            </button>
            <button type="button" data-dialog-confirm className={danger ? "btn-danger-solid btn-sm" : "btn-primary btn-sm"} disabled={!canSubmit} onClick={submit}>
              {opts?.confirmLabel ?? t("ui.confirm")}
            </button>
          </>
        }
      >
        {p && (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="field-label">{p.label}{p.required ? " *" : ""}</label>
            {p.multiline ? (
              <textarea id={inputId} data-dialog-input className="field py-2.5 min-h-[88px]" dir={p.inputDir ?? "auto"} value={value} placeholder={p.placeholder} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <input id={inputId} data-dialog-input className="field" dir={p.inputDir ?? "auto"} value={value} placeholder={p.placeholder} onChange={(e) => setValue(e.target.value)} />
            )}
          </form>
        )}
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialogs() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs() needs <DialogProvider> (app/providers.tsx)");
  return ctx;
}
