import { useRef } from "react";

/**
 * `value` as it stood when the running turn started, or null while idle.
 * Session tools reach the harness when a turn starts, so anything changed
 * after this snapshot is still waiting for the next one.
 */
export function useTurnStartSnapshot<T>(value: T, busy: boolean): T | null {
  const snapshot = useRef<T | null>(busy ? value : null);
  const wasBusy = useRef(busy);
  if (wasBusy.current !== busy) {
    wasBusy.current = busy;
    snapshot.current = busy ? value : null;
  }
  return snapshot.current;
}
