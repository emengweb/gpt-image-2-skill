import { useId, useMemo, type ReactNode } from "react";
import { FieldContext } from "@/lib/field-context";

export function FieldLabel({
  children,
  hint,
  kbd,
  inline,
  htmlFor,
}: {
  children: ReactNode;
  hint?: ReactNode;
  kbd?: ReactNode;
  inline?: boolean;
  htmlFor?: string;
}) {
  const Labeller = htmlFor ? "label" : "span";
  return (
    <div
      className={`flex items-center gap-1.5 ${inline ? "justify-start" : "justify-between"} ${inline ? "" : "mb-1.5"}`}
    >
      <Labeller
        htmlFor={htmlFor}
        className="text-[12px] font-semibold text-foreground"
      >
        {children}
      </Labeller>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
      {kbd && <span className="kbd">{kbd}</span>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  id: idProp,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-err` : undefined;

  const ctx = useMemo(
    () => ({ id, hintId, errorId, invalid: Boolean(error) }),
    [id, hintId, errorId, error]
  );

  return (
    <FieldContext.Provider value={ctx}>
      <div className="flex flex-col mb-3.5">
        <FieldLabel htmlFor={id} hint={hint}>
          {label}
        </FieldLabel>
        {children}
        {hint && (
          <span id={hintId} className="sr-only">
            {typeof hint === "string" ? hint : null}
          </span>
        )}
        {error && (
          <span
            id={errorId}
            role="alert"
            className="mt-1 text-[11px] text-status-err"
          >
            {error}
          </span>
        )}
      </div>
    </FieldContext.Provider>
  );
}
