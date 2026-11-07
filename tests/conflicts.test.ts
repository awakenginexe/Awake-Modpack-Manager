import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { BackendError, type DependencyConflict } from '../src/backend/contract';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import DependencyConflicts from '../src/components/DependencyConflicts.vue';
import NativeImportDialog from '../src/components/NativeImportDialog.vue';
import { chosenResolutions, conflictReport, describeConflict, mergeResolutions } from '../src/domain/conflicts';
import { newProject } from '../src/domain/project';
import { translate } from '../src/i18n';
import { createSession, SessionKey } from '../src/state/session';
import { BLOCKER_CONFLICTS, FakeCore } from './fixtures/fakeCore';

/**
 * Error-to-UI presentation of dependency conflicts. The fixture mirrors what the real helper reported for the
 * owner's Revelations pack (Puzzles Lib pinned by Easy Magic; Forge Config API Port required by Skeleton AI Fix),
 * as structured details, so the UI never parses or shows the raw project ID QAGBst4M as the explanation.
 */
const helper = (core: FakeCore) => createHelperClient({ transport: core, clientVersion: 'test', pollMs: 1 });
const conflicts = BLOCKER_CONFLICTS.conflicts as DependencyConflict[];
const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params);
let core: FakeCore;
beforeEach(() => localStorage.clear());
afterEach(() => expect(core?.violations ?? []).toEqual([]));

async function importSession(c: FakeCore) {
  core = c;
  core.conflicts = BLOCKER_CONFLICTS;
  const session = createSession(helper(core), { pollMs: 1 });
  await session.connect();
  const token = await session.backend.uploadImport!(new Blob([new Uint8Array(500)]));
  const ins = await session.backend.inspectImport!(token, 'mrpack');
  const made = await session.createInstance({ name: 'Revelations-like', minecraftVersion: ins.minecraftVersion, loader: ins.loader.kind, loaderVersion: ins.loader.version });
  await session.refreshInstances();
  return { session, token, id: made!.result!.instanceId! };
}

describe('conflict presentation model', () => {
  it('names the library, the requesting mod, both versions, the evidence and the affected files', () => {
    const view = describeConflict(conflicts[0]!);
    expect(view.title).toBe('Puzzles Lib');
    expect(en(view.badge.key)).toBe('Different version requested');
    const explanation = en(view.explanation.key, view.explanation.params);
    expect(explanation).toContain('Easy Magic');
    expect(explanation).toContain('Puzzles Lib');
    expect(explanation).toContain('v8.1.33-1.20.1-Forge');
    expect(explanation).not.toContain('QAGBst4M');
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.mod).toBe('Easy Magic');
    expect(en(view.rows[0]!.requested.key, view.rows[0]!.requested.params)).toBe('version v8.0.15-1.20.1-Forge');
    expect(en(view.rows[0]!.evidence.key, view.rows[0]!.evidence.params)).toBe('accepts 8.1.33 (range [8.0.0,))');
    expect(view.rows[0]!.evidence.tone).toBe('ok');
    expect(view.affectedFiles).toEqual(['EasyMagic-v8.0.1-1.20.1-Forge.jar', 'PuzzlesLib-v8.1.33-1.20.1-Forge.jar']);
    expect(view.options.map((o) => en(o.label.key, o.label.params))).toEqual(['Keep Puzzles Lib v8.1.33-1.20.1-Forge']);
    expect(view.blocked).toBeNull();
  });

  it('offers to proceed without an undeclared requirement and blocks contradicted ones', () => {
    const missing = describeConflict(conflicts[1]!);
    expect(en(missing.rows[0]!.evidence.key)).toBe('not declared in the mod’s own metadata');
    expect(missing.options.map((o) => o.resolution)).toEqual([{ provider: 'modrinth', projectId: 'ohNO6lps', versionId: null }]);
    const violated: DependencyConflict = { ...conflicts[1]!, resolutions: [], requests: [{ ...conflicts[1]!.requests[0]!, evidence: { result: 'violated', modId: 'forgeconfigapiport', declaredRange: '[8,)', mandatory: true, selectedModVersion: null } }] };
    const blocked = describeConflict(violated);
    expect(blocked.options).toEqual([]);
    expect(blocked.blocked?.key).toBe('conflictBlocked');
    expect(en(blocked.rows[0]!.evidence.key, blocked.rows[0]!.evidence.params)).toBe('declares it mandatory ([8,))');
    expect(describeConflict({ ...violated, kind: 'loader_bridge' }).blocked?.key).toBe('conflictBlockedBridge');
  });

  it('needs an explicit choice for every problem and merges decisions across rounds', () => {
    const views = conflicts.map(describeConflict);
    expect(chosenResolutions(views, {})).toBeNull();
    expect(chosenResolutions(views, { [views[0]!.id]: 'use:mIyVGf3d' })).toBeNull();
    const all = chosenResolutions(views, { [views[0]!.id]: 'use:mIyVGf3d', [views[1]!.id]: 'without' });
    expect(all).toEqual([{ provider: 'modrinth', projectId: 'QAGBst4M', versionId: 'mIyVGf3d' }, { provider: 'modrinth', projectId: 'ohNO6lps', versionId: null }]);
    expect(mergeResolutions(all!.slice(0, 1), [{ provider: 'modrinth', projectId: 'QAGBst4M', versionId: 'other' }, all![1]!])).toEqual([{ provider: 'modrinth', projectId: 'QAGBst4M', versionId: 'other' }, all![1]!]);
    expect(conflictReport(new BackendError('rejected', 'x'))).toBeNull();
  });
});

describe('helper conflicts reach the UI as structured errors', () => {
  it('fails the import at once with every conflict, named, and imports after reviewed decisions', async () => {
    const { session, token, id } = await importSession(new FakeCore());
    const error = (await session.prepareImport(id, token, 'mrpack', false, 'pack.mrpack', undefined, true).catch((e: unknown) => e)) as BackendError;
    expect(error).toBeInstanceOf(BackendError);
    expect(error.code).toBe('dependency-conflict');
    expect(error.conflicts?.map((c) => [c.kind, c.title, c.requests.map((r) => r.title)])).toEqual([
      ['version_pin', 'Puzzles Lib', ['Easy Magic']], ['missing_dependency', 'Forge Config API Port', ['Skeleton AI Fix']]]);
    // The import fails immediately: no review screen to wait for, and the upload is kept for the retry.
    expect(session.review.phase).toBe('failed');
    expect(session.review.plan).toBeNull();
    expect(core.uploads.get(token)?.discarded).toBe(false);
    const decisions = [{ provider: 'modrinth' as const, projectId: 'QAGBst4M', versionId: 'mIyVGf3d' }, { provider: 'modrinth' as const, projectId: 'ohNO6lps', versionId: null }];
    const plan = await session.prepareImport(id, token, 'mrpack', false, 'pack.mrpack', decisions, true);
    expect(core.log.filter((l) => l.method === 'imports.prepare').at(-1)?.params.dependencyResolutions).toEqual([{ projectId: 'QAGBst4M', versionId: 'mIyVGf3d' }, { projectId: 'ohNO6lps', versionId: null }]);
    const reviewed = plan.issues.filter((i) => i.code === 'dependency-reviewed').map((i) => i.message);
    expect(reviewed).toEqual([
      'Puzzles Lib kept at the selected version for Easy Magic (its loader metadata accepts this version)',
      'Installed without Forge Config API Port: Skeleton AI Fix (its loader metadata does not declare it)']);
    expect(core.uploads.get(token)?.discarded).toBe(true);
    await session.apply();
    expect(session.review.phase).toBe('done');
  });

  it('discards the upload after a conflict unless the caller keeps it for review', async () => {
    const { session, token, id } = await importSession(new FakeCore());
    await expect(session.prepareImport(id, token, 'mrpack', false, 'pack.mrpack')).rejects.toMatchObject({ code: 'dependency-conflict' });
    expect(core.uploads.get(token)?.discarded).toBe(true);
  });

  it('with a 0.2.0 helper shows the conflict without details and never sends decisions', async () => {
    const c = new FakeCore();
    c.evidence = false;
    const { session, token, id } = await importSession(c);
    const error = (await session.prepareImport(id, token, 'mrpack', false, 'pack.mrpack', undefined, true).catch((e: unknown) => e)) as BackendError;
    expect(error.code).toBe('dependency-conflict');
    expect(error.conflicts).toBeUndefined();
    expect(conflictReport(error)?.structured).toBe(false);
    await expect(session.backend.prepareImport!(id, token, 'mrpack', false, [{ provider: 'modrinth', projectId: 'QAGBst4M', versionId: 'mIyVGf3d' }])).rejects.toMatchObject({ code: 'unsupported' });
    expect(core.log.some((l) => 'dependencyResolutions' in l.params)).toBe(false);
  });
});

describe('DependencyConflicts panel', () => {
  const error = new BackendError('dependency-conflict', 'Dependency review required (2)', 'DEPENDENCY_CONFLICT', conflicts);
  it('shows names, versions, explanation, evidence and affected files, and retries only with every decision made', async () => {
    const wrapper = mount(DependencyConflicts, { props: { error, canResolve: true } });
    const text = wrapper.text();
    for (const s of ['2 dependency problem(s) need your decision', 'Puzzles Lib', 'Easy Magic', 'v8.0.15-1.20.1-Forge', 'Selected: v8.1.33-1.20.1-Forge (PuzzlesLib-v8.1.33-1.20.1-Forge.jar)',
      'accepts 8.1.33 (range [8.0.0,))', 'Forge Config API Port', 'Skeleton AI Fix', 'not declared in the mod’s own metadata', 'EasyMagic-v8.0.1-1.20.1-Forge.jar', 'Install without Forge Config API Port']) {
      expect(text).toContain(s);
    }
    expect(wrapper.find('[data-conflict="version_pin|modrinth:QAGBst4M"] h3').text()).toBe('Puzzles Lib');
    const retry = wrapper.find('.retry button');
    expect(retry.attributes('disabled')).toBeDefined();
    expect(text).toContain('Choose an option for every problem to continue.');
    const radios = wrapper.findAll('input[type="radio"]');
    expect(radios.map((r) => (r.element as HTMLInputElement).checked)).toEqual([false, false]); // nothing preselected
    await radios[0]!.setValue(true);
    expect(wrapper.find('.retry button').attributes('disabled')).toBeDefined();
    await radios[1]!.setValue(true);
    await wrapper.find('.retry button').trigger('click');
    expect(wrapper.emitted('retry')).toEqual([[[{ provider: 'modrinth', projectId: 'QAGBst4M', versionId: 'mIyVGf3d' }, { provider: 'modrinth', projectId: 'ohNO6lps', versionId: null }]]]);
  });

  it('offers no retry for blocked conflicts or helpers that cannot accept decisions', () => {
    const blocked = new BackendError('dependency-conflict', 'x', 'DEPENDENCY_CONFLICT', [{ ...conflicts[1]!, resolutions: [] }]);
    const a = mount(DependencyConflicts, { props: { error: blocked, canResolve: true } });
    expect(a.find('.retry').exists()).toBe(false);
    expect(a.text()).toContain('This cannot be resolved by review');
    const b = mount(DependencyConflicts, { props: { error, canResolve: false } });
    expect(b.find('input[type="radio"]').exists()).toBe(false);
    expect(b.text()).toContain('This Manager helper cannot accept reviewed decisions.');
    const c = mount(DependencyConflicts, { props: { error: new BackendError('dependency-conflict', 'Two requested dependencies require different versions of QAGBst4M', 'DEPENDENCY_CONFLICT'), canResolve: true } });
    expect(c.text()).toContain('without details');
  });
});

describe('NativeImportDialog with dependency conflicts', () => {
  it('shows the conflicts in place right after preparing, retries with decisions and opens the review', async () => {
    core = new FakeCore();
    core.conflicts = BLOCKER_CONFLICTS;
    const session = createSession(helper(core), { pollMs: 1 });
    await session.connect();
    const preview = { format: 'mrpack' as const, warnings: [], stats: { archiveBytes: 500, entries: 1, overrideBytes: 0 },
      project: newProject({ name: 'Revelations-like', version: '1.0.0', minecraftVersion: '1.20.1', loader: { kind: 'forge', version: '47.4.28' }, mods: [] }) };
    const wrapper = mount(NativeImportDialog, { props: { file: new File([new Uint8Array(500)], 'pack.mrpack'), preview }, global: { provide: { [SessionKey as symbol]: session } } });
    await wrapper.find('form').trigger('submit');
    for (let i = 0; i < 50 && !wrapper.find('[data-testid="dependency-conflicts"]').exists(); i++) { await flushPromises(); await new Promise((r) => setTimeout(r, 5)); }
    expect(wrapper.find('[data-testid="dependency-conflicts"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Puzzles Lib');
    expect(wrapper.text()).not.toContain('The import was not prepared'); // the structured panel replaces the generic error
    expect(wrapper.emitted('review')).toBeUndefined();
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false); // the retry is the next step, not a new upload
    const radios = wrapper.findAll('input[type="radio"][name^="version_pin"], input[type="radio"][name^="missing_dependency"]');
    for (const r of radios) await r.setValue(true);
    await wrapper.find('.retry button').trigger('click');
    for (let i = 0; i < 50 && !wrapper.emitted('review'); i++) { await flushPromises(); await new Promise((r) => setTimeout(r, 5)); }
    expect(wrapper.emitted('review')).toHaveLength(1);
    expect(core.log.filter((l) => l.method === 'inbox.begin')).toHaveLength(1); // no second upload
    expect(session.review.plan?.issues.some((i) => i.code === 'dependency-reviewed')).toBe(true);
  });
});
