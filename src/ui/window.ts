import { isDesktopHost } from '../backend/launcher/transport';
import { load, save } from '../domain/storage';

interface Saved { width: number; height: number; x: number; y: number; maximized: boolean }

/** Reopen where the user left the window, then show it (it starts hidden so nothing flashes). */
export async function initWindow() {
  if (!isDesktopHost()) return;
  const { getCurrentWindow, PhysicalPosition, PhysicalSize, availableMonitors } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const saved = load<Saved | null>('window', null);
  try {
    if (saved) {
      const monitors = await availableMonitors();
      const visible = monitors.some((m) => saved.x + 80 < m.position.x + m.size.width && saved.x + saved.width - 80 > m.position.x && saved.y >= m.position.y - 20 && saved.y < m.position.y + m.size.height - 60);
      if (visible) { await win.setSize(new PhysicalSize(saved.width, saved.height)); await win.setPosition(new PhysicalPosition(saved.x, saved.y)); }
      if (saved.maximized) await win.maximize();
    }
  } finally {
    await win.show();
    await win.setFocus();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const maximized = await win.isMaximized();
      const previous = load<Saved | null>('window', null);
      if (maximized && previous) { save('window', { ...previous, maximized }); return; }
      if (await win.isMinimized()) return;
      const [size, position] = await Promise.all([win.outerSize(), win.outerPosition()]);
      save('window', { width: size.width, height: size.height, x: position.x, y: position.y, maximized });
    }, 400);
  };
  await win.onResized(remember);
  await win.onMoved(remember);
}
