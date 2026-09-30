import { useEffect, useRef } from "react";

/** Open dialogs, innermost last. Only the top one reacts to Escape, so a
 *  confirm opened over another dialog doesn't close both at once. */
const stack: symbol[] = [];

/**
 * Drop inside any modal overlay: closes it on Escape while it is mounted.
 * `disabled` keeps it open during a pending action (e.g. deleting…).
 */
export function EscapeToClose({ onClose, disabled = false }: { onClose: () => void; disabled?: boolean }) {
  const onCloseRef = useRef(onClose);
  const disabledRef = useRef(disabled);
  onCloseRef.current = onClose;
  disabledRef.current = disabled;

  useEffect(() => {
    const id = Symbol("dialog");
    stack.push(id);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || stack[stack.length - 1] !== id) return;
      if (disabledRef.current) return;
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
    };
  }, []);

  return null;
}
