import { reactive, shallowRef, type Component } from 'vue';

/* App-wide desktop surfaces: one right-click menu, one dialog at a time, a stack of toasts. */

export interface MenuItem {
  label: string;
  icon?: Component;
  action?: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled, or a key hint. */
  hint?: string;
  separator?: boolean;
}
export const separator: MenuItem = { label: '', separator: true };

export const menu = shallowRef<{ x: number; y: number; items: MenuItem[] } | null>(null);
/** Open a menu at the pointer (or below a button that was clicked). */
export function openMenu(event: MouseEvent, items: MenuItem[]) {
  event.preventDefault();
  event.stopPropagation();
  const visible = items.filter((item, i) => !item.separator || (i > 0 && !items[i - 1]!.separator && i < items.length - 1));
  if (visible.length) menu.value = { x: event.clientX, y: event.clientY, items: visible };
}
export const closeMenu = () => { menu.value = null; };

export interface DialogRequest {
  title: string;
  body?: string;
  details?: string[];
  confirm: string;
  cancel: string;
  danger?: boolean;
  /** The user must type this exact text before confirming. */
  requireText?: string;
  requireLabel?: string;
  /** Asks for a value: resolves to the entered text. */
  input?: { label: string; value: string; maxLength?: number };
  resolve: (value: string | boolean | null) => void;
}
export const dialog = shallowRef<DialogRequest | null>(null);

export function confirmDialog(request: Omit<DialogRequest, 'resolve' | 'input'>): Promise<boolean> {
  return new Promise((resolve) => { dialog.value = { ...request, resolve: (v) => resolve(v === true) }; });
}
export function promptDialog(request: Omit<DialogRequest, 'resolve' | 'requireText' | 'requireLabel' | 'danger'>): Promise<string | null> {
  return new Promise((resolve) => { dialog.value = { ...request, resolve: (v) => resolve(typeof v === 'string' ? v : null) }; });
}
export function settleDialog(value: string | boolean | null) {
  const d = dialog.value;
  dialog.value = null;
  d?.resolve(value);
}

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';
export interface Toast { id: number; message: string; tone: ToastTone }
export const toasts = reactive<Toast[]>([]);
let nextToast = 1;
export function dismissToast(id: number) {
  const i = toasts.findIndex((x) => x.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
export function toast(message: string, tone: ToastTone = 'info', ms = tone === 'error' ? 9000 : 4500) {
  const id = nextToast++;
  toasts.push({ id, message, tone });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => dismissToast(id), ms);
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { /* the clipboard may be refused; nothing depends on it */ }
}
