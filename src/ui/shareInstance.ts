import { t } from '../i18n';
import { confirmDialog } from './desktop';

/** One consent wording wherever a Launcher instance can be connected. */
export function confirmShare(name: string) {
  return confirmDialog({
    title: t('shareTitle', { name }),
    body: t('shareBody'),
    details: [t('shareDetailPlay'), t('shareDetailLock'), t('shareDetailStop')],
    confirm: t('shareConfirm'),
    cancel: t('cancel'),
  });
}

/** One wording wherever the Launcher can be given its instance back. */
export function confirmStopShare(name: string) {
  return confirmDialog({ title: t('shareStopTitle', { name }), body: t('shareStopBody'), confirm: t('shareStopConfirm'), cancel: t('cancel') });
}
