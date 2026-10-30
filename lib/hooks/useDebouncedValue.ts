"use client";

import { useEffect, useState } from "react";

/** `value`, once it has stopped changing for `ms` — a search box sends one request per pause, not per keystroke. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
