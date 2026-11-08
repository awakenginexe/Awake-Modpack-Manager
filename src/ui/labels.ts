import type { InstanceSummary, LoaderKind, ModSource, OperationKind, OperationState, PackProviderId, PlanAction } from '../backend/contract';
import { t, type MessageKey } from '../i18n';

export const opStateKey: Record<OperationState, MessageKey> = {
  queued: 'opQueued', resolving: 'opResolving', downloading: 'opDownloading', prepared: 'opPrepared',
  acquiring: 'opWaiting', revalidating: 'opRevalidating', backing_up: 'opBackingUp', applying: 'opApplying', verifying: 'opVerifying', rolling_back: 'opRollingBack',
  completed: 'opCompleted', cancelled: 'opCancelled', failed: 'opFailed', rolled_back: 'opRolledBack', recovery_required: 'opRecoveryRequired',
};
export const opStateTone: Record<OperationState, string> = {
  queued: 'info', resolving: 'info', downloading: 'info', prepared: 'info',
  acquiring: 'info', revalidating: 'info', backing_up: 'info', applying: 'info', verifying: 'info', rolling_back: 'warn',
  completed: 'ok', cancelled: '', failed: 'error', rolled_back: 'warn', recovery_required: 'error',
};
export const opKindKey: Record<OperationKind, MessageKey> = { 'apply-plan': 'kindApply', 'create-instance': 'kindCreate', 'delete-instance': 'kindDelete', 'install-pack': 'kindInstallPack', export: 'kindExport', launch: 'kindLaunch' };
export const packProviderNames: Record<PackProviderId, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', atlauncher: 'ATLauncher', technic: 'Technic' };
export const planActionKey: Record<PlanAction, MessageKey> = { install: 'planInstall', update: 'planUpdate', remove: 'planRemove', enable: 'planEnable', disable: 'planDisable', keep: 'planKeep', policy: 'planPolicy', override: 'planOverride' };

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
  return ({ 'not-running': 'launcherNotRunning', 'unsupported-profile': 'profileUnsupported', identity: 'launcherIdentity', unsupported: 'connUnsupported', protocol: 'launcherProtocol', 'helper-unavailable': 'helperUnavailable' } as Record<string, MessageKey>)[code] ?? 'connFailed';
}
/** Plain-language next step for import/provider failures; the helper's own message is shown with it. */
export function importErrorHint(code: string): MessageKey | null {
  return ({ 'invalid-archive': 'importInvalidArchiveHint', 'provider-restricted': 'importRestrictedHint', unsupported: 'importUnsupportedHint', 'stale-revision': 'importStaleHint' } as Record<string, MessageKey>)[code] ?? null;
}
export function connectErrorHint(code: string): MessageKey {
  return ({ 'not-running': 'launcherNotRunningHint', 'unsupported-profile': 'profileUnsupportedHint', identity: 'launcherIdentityHint', unsupported: 'connUnsupportedHint', protocol: 'launcherProtocolHint', 'helper-unavailable': 'helperUnavailableHint' } as Record<string, MessageKey>)[code] ?? 'connFailedHint';
}
