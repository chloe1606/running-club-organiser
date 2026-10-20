"use client";

import { createContext, useContext, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

const SavingContext = createContext<{ pending: boolean; active: string; setActive: (id: string) => void } | undefined>(undefined);

export function SavingProvider({ pending, children }: { pending: boolean; children: ReactNode }) {
  const [active, setActive] = useState("");
  return <SavingContext.Provider value={{ pending, active, setActive }}>{children}</SavingContext.Provider>;
}

export function SavingButton({ savingLabel, busy, children, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  savingLabel: string; busy?: boolean;
}) {
  const id = useId();
  const context = useContext(SavingContext);
  const saving = busy ?? (context?.pending && context.active === id) ?? false;
  return <button {...props} disabled={props.disabled || saving} aria-busy={saving || undefined} onClick={event => {
    context?.setActive(id);
    onClick?.(event);
  }}>{saving ? <><span className="saving-spinner" aria-hidden="true" />{savingLabel}</> : children}</button>;
}
