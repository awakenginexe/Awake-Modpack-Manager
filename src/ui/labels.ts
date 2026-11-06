import type { InstanceSummary, LoaderKind, ModSource, OperationKind, OperationState, PackProviderId, PlanAction } from '../backend/contract';
import { t, type MessageKey } from '../i18n';

export const opStateKey: Record<OperationState, MessageKey> = {
  preparing: 'opPreparing', waiting: 'opWaiting', applying: 'opApplying', verifying: 'opVerifying', completed: 'opCompleted',
  cancelled: 'opCancelled', recovering: 'opRecovering', rolled_back: 'opRolledBack', needs_attention: 'opNeedsAttention',
};
export const opStateTone: Record<OperationState, string> = {
  preparing: 'info', waiting: 'info', applying: 'info', verifying: 'info', completed: 'ok',
  cancelled: '', recovering: 'warn', rolled_back: 'warn', needs_attention: 'error',
};
export const opKindKey: Record<OperationKind, MessageKey> = { 'apply-plan': 'kindApply', 'create-instance': 'kindCreate', 'install-pack': 'kindInstallPack', export: 'kindExport' };
export const packProviderNames: Record<PackProviderId, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', atlauncher: 'ATLauncher', technic: 'Technic' };
export const planActionKey: Record<PlanAction, MessageKey> = { install: 'planInstall', update: 'planUpdate', remove: 'planRemove', enable: 'planEnable', disable: 'planDisable', keep: 'planKeep' };

const loaderNames: Record<LoaderKind, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', vanilla: '' };
export const loaderLabel = (k: LoaderKind) => (k === 'vanilla' ? t('vanilla') : loaderNames[k]);
export const sourceLabel = (s: ModSource) => (s === 'manual' ? t('sourceManual') : s === 'modrinth' ? 'Modrinth' : 'CurseForge');

export function blockedText(inst: InstanceSummary): string {
  const map: Record<string, MessageKey> = { running: 'blockedRunning', broken: 'blockedBroken', busy: 'blockedBusy', unloaded: 'blockedUnloaded', conflict: 'blockedConflict' };
  const key = inst.blockedReason ? map[inst.blockedReason] : undefined;
  return key ? t(key) : inst.blockedReason || t('blockedGeneric');
}

export function formatBytes(n?: number) {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "1.21.1 · NeoForge", or a clear "not reported" when the Launcher doesn't send it. */
export function instanceSubtitle(inst: InstanceSummary): string {
  const parts = [inst.minecraftVersion, inst.loader ? loaderLabel(inst.loader.kind) : undefined].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('versionUnknown');
}

/** Connection problem → headline and next step. */
export function connectErrorTitle(code: string): MessageKey {
  return ({ 'not-running': 'launcherNotRunning', 'unsupported-profile': 'profileUnsupported', identity: 'launcherIdentity', unsupported: 'connUnsupported', protocol: 'launcherProtocol' } as Record<string, MessageKey>)[code] ?? 'connFailed';
}
export function connectErrorHint(code: string): MessageKey {
  return ({ 'not-running': 'launcherNotRunningHint', 'unsupported-profile': 'profileUnsupportedHint', identity: 'launcherIdentityHint', unsupported: 'connUnsupportedHint', protocol: 'launcherProtocolHint' } as Record<string, MessageKey>)[code] ?? 'connFailedHint';
}
