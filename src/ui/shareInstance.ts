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
