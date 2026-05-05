import { createContext, useContext } from "react";

type FieldCtx = {
  /** Auto-generated or caller-provided id that labels will point to. */
  id?: string;
  /** Error message id for aria-describedby. */
  errorId?: string;
  /** Hint message id for aria-describedby. */
  hintId?: string;
  /** Whether the controlled input is currently in an invalid state. */
  invalid?: boolean;
};

export const FieldContext = createContext<FieldCtx>({});

/**
 * Resolve the form control id. Prefer an explicit override, then the id
 * emitted by the surrounding <Field>. Returns undefined when neither exists
 * so native elements don't render `id=""`.
 */
export function useFieldId(overrideId?: string): string | undefined {
  const ctx = useContext(FieldContext);
  return overrideId ?? ctx.id;
}

/**
 * Build an aria-describedby string pointing at the Field's hint and/or error.
 * Merges with any id the caller already passed.
 */
export function useFieldDescribedBy(override?: string): string | undefined {
  const ctx = useContext(FieldContext);
  const parts = [override, ctx.hintId, ctx.errorId].filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

export function useFieldInvalid(override?: boolean): boolean | undefined {
  const ctx = useContext(FieldContext);
  return override ?? ctx.invalid;
}
