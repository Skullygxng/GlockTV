import { type RefObject, useEffect, useRef } from 'react';

/*
 * The keyboard and focus contract every dialog-shaped surface owes, in one
 * place. It owns only generic behaviour - Escape, focus entry, focus
 * restoration and optional Tab containment. Layout, animation and everything
 * the surface actually does stay with the caller.
 *
 * The containFocus split is the important one. A true modal paints a backdrop
 * over the page, so trapping Tab inside it matches what the user sees. The
 * watch-party room controls and roster are anchored popovers with no backdrop:
 * the page behind them stays visible and clickable, so trapping Tab there
 * would strand a keyboard user in a panel that never looked closed, and
 * aria-modal would tell a screen reader the rest of the page is inert when it
 * is not. They get Escape and focus handling; they do not get the trap.
 */

/* Anything that takes focus by Tab. Options in an activedescendant listbox
   carry tabindex="-1" and are deliberately excluded. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].map((selector) => `${selector}:not([tabindex="-1"])`).join(', ');

export interface DialogBehaviorOptions {
  /*
   * Whether the dialog is showing. Callers that render the dialog from a
   * parent's own JSX cannot mount and unmount a hook with it, so open is
   * explicit: it is what starts focus entry and what restores focus.
   */
  open?: boolean;
  /*
   * Called when Escape reaches the dialog. A surface with an inner layer -
   * a suggestion list, a server menu - stages it here: close the inner layer
   * and return, or close the dialog. Anything already handled deeper in the
   * tree calls preventDefault and never reaches this.
   */
  onClose: () => void;
  /* True for a backdrop-covering modal, false for an anchored popover. */
  containFocus?: boolean;
  /* Where focus should land on open. Defaults to the first focusable control. */
  initialFocus?: RefObject<HTMLElement | null>;
  /*
   * Where focus should land on close. Defaults to whatever had focus when the
   * dialog opened, which is right for a dialog opened by clicking its trigger.
   * Pass the trigger explicitly where the dialog can be opened without its
   * trigger holding focus, so the return target does not depend on that.
   */
  returnFocus?: RefObject<HTMLElement | null>;
  /*
   * Set false where the surface focuses something itself (the title picker
   * autofocuses its search box on purpose). Avoids fighting over focus, and
   * avoids opening a phone keyboard where no input was meant to be focused.
   */
  autoFocus?: boolean;
}

/*
 * Returns the ref to put on the dialog element itself - the panel, not the
 * backdrop.
 */
export function useDialogBehavior<T extends HTMLElement>({
  open = true,
  onClose,
  containFocus = true,
  initialFocus,
  returnFocus,
  autoFocus = true,
}: DialogBehaviorOptions): RefObject<T | null> {
  const dialog = useRef<T>(null);
  /* Read at event time, so a caller's inline arrow does not re-run the effect
     and re-steal focus on every render. */
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    if (autoFocus) {
      const target = initialFocus?.current
        ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
        ?? dialog.current;
      target?.focus();
    }
    return () => {
      /* Only somewhere still on the page: a trigger removed while the dialog
         was open has nowhere to put focus back, and blurring to nothing is
         worse than leaving focus alone. */
      const target = returnFocus?.current ?? opener;
      if (target?.isConnected) target.focus();
    };
    // Focus entry happens once per open, not on every option change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const node = dialog.current;
      if (!node) return;

      if (event.key === 'Escape') {
        // An inner layer that consumed Escape calls preventDefault; React's
        // handlers run before this document listener, so the dialog only sees
        // what nothing else wanted.
        if (event.defaultPrevented) return;
        event.preventDefault();
        close.current();
        return;
      }

      if (event.key !== 'Tab' || !containFocus) return;

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) {
        // Nothing to land on, so Tab must not leave for the page behind.
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!node.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [containFocus, open]);

  return dialog;
}
