"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface SearchOption {
  value: string;
  label: string;
}

export function SearchableSelect({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: SearchOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = options.filter(option =>
    option.label.toLocaleLowerCase().includes(normalizedQuery),
  );
  const visibleOptions = normalizedQuery ? filteredOptions.slice(0, 100) : filteredOptions.slice(0, 50);
  const selectedLabel = options.find(option => option.value === value)?.label;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(option: SearchOption) {
    onChange(option.value);
    close();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return <div className={`searchable-select${open ? " is-open" : ""}`} ref={rootRef}
    onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); close(); triggerRef.current?.focus(); } }}>
    <span className="searchable-select-label">{label}</span>
    <button ref={triggerRef} type="button" className="searchable-select-trigger" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled}
      onClick={() => open ? close() : setOpen(true)}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
      <span className={selectedLabel ? "" : "searchable-select-placeholder"}>{selectedLabel ?? placeholder}</span>
      <span className="searchable-select-chevron" aria-hidden="true" />
    </button>
    {open && <div className="searchable-select-popover">
      <label className="searchable-select-search">
        <span className="sr-only">Search {label}</span>
        <input ref={searchRef} type="search" aria-label={`Search ${label}`} placeholder="Type to filter" value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); rootRef.current?.querySelector<HTMLButtonElement>("[role=option]")?.focus(); } }} />
      </label>
      <div className="search-result-count" role="status">
        {filteredOptions.length === 0 ? "No matches" : normalizedQuery ? `${filteredOptions.length} matches` : options.length > visibleOptions.length ? `Showing ${visibleOptions.length} of ${options.length} · type to search` : `${options.length} options`}
      </div>
      <div id={listId} className="searchable-select-options" role="listbox" aria-label={label}>
        {visibleOptions.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value}
          className="searchable-select-option" onClick={() => choose(option)} onKeyDown={event => {
            const optionButtons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
            const currentIndex = optionButtons.indexOf(event.currentTarget);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              optionButtons[Math.max(0, Math.min(optionButtons.length - 1, currentIndex + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
            }
          }}>{option.label}</button>)}
        {filteredOptions.length > visibleOptions.length && <p className="searchable-select-limit">Refine your search to see more results.</p>}
      </div>
    </div>}
  </div>;
}