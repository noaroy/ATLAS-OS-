import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync, symlinkSync, unlinkSync, existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorkspace, removeWorkspace, captureDiff, auditWorkspace, type Workspace,
} from '../src/index.ts';

/**
 * Le lien `node_modules` du runner n'est pas une modification — mais le
 * remplacer, le rediriger ou le supprimer en est une.
 *
 * Régression d'un vrai essai du Controller Bridge : `createWorkspace` pose un
 * lien `node_modules` dans chaque worktree, le `.gitignore` du dépôt dit
 * `node_modules/` — ce qui ignore un répertoire, pas un lien — et
 * `git status --porcelain` voyait donc `?? node_modules`. L'audit refusait
 * alors toute tâche : « SECURITY_VIOLATION: hors périmètre : node_modules ».
 *
 * Le dépôt de ces tests reproduit exactement cette forme : un `.gitignore`
 * qui porte `node_modules/`, et des dépendances installées à la racine.
 */

const posix = process.platform !== 'win32';
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' });

let dir: string;
let repoRoot: string;
let ws: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-nm-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(join(repoRoot, 'fixture'), { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@atlas.local'], repoRoot);
  git(['config', 'user.name', 'ATLAS Test'], repoRoot);
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
  writeFileSync(join(repoRoot, 'fixture', 'add.ts'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  writeFileSync(join(repoRoot, '.env'), 'SECRET=intact\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--quiet', '-m', 'base'], repoRoot);
  mkdirSync(join(repoRoot, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repoRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n', 'utf8');

  ws = createWorkspace({ repoRoot, taskId: 'tsk_nm', root: join(dir, 'ws') });
});

afterEach(() => {
  removeWorkspace(repoRoot, ws);
  rmSync(dir, { recursive: true, force: true });
});

const editInScope = () =>
  writeFileSync(join(ws.path, 'fixture', 'add.ts'), '// édité\nexport const add = (a, b) => a + b;\n', 'utf8');

const audit = () => auditWorkspace(ws, captureDiff(ws), ['fixture']);

describe('le lien node_modules posé par le runner', { skip: !posix && 'liens POSIX seulement' }, () => {
  test('la forme du bug : git voit le lien malgré `node_modules/` dans le .gitignore', () => {
    assert.equal(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink(), true);
    assert.equal(ws.linkedNodeModules, join(repoRoot, 'node_modules'));
    assert.match(git(['status', '--porcelain'], ws.path), /^\?\? node_modules$/m);
  });

  test('(1) intact, il n’apparaît ni dans le diff ni dans l’audit', () => {
    editInScope();
    const diff = captureDiff(ws);
    assert.deepEqual(diff.filesChanged, ['fixture/add.ts']);
    assert.deepEqual(diff.filesAdded, []);
    assert.deepEqual(diff.filesDeleted, []);
    assert.doesNotMatch(diff.diff, /node_modules/);
    assert.doesNotMatch(diff.stat, /node_modules/);

    const verdict = auditWorkspace(ws, diff, ['fixture']);
    assert.deepEqual(verdict, { clean: true, violations: [] });
  });

  test('(1) intact et sans autre modification : un diff vide, pas un ajout', () => {
    const diff = captureDiff(ws);
    assert.equal(diff.filesAdded.length + diff.filesChanged.length + diff.filesDeleted.length, 0);
    assert.equal(diff.diff, '');
  });

  test('(2) remplacé par un vrai répertoire : invisible pour git, refusé par l’audit', () => {
    editInScope();
    unlinkSync(join(ws.path, 'node_modules'));
    mkdirSync(join(ws.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(ws.path, 'node_modules', 'dep', 'index.js'), 'module.exports = "piégé";\n', 'utf8');

    // Le .gitignore masque le répertoire : c'est pourquoi le diff ne suffit pas.
    assert.doesNotMatch(git(['status', '--porcelain'], ws.path), /node_modules/);
    const verdict = audit();
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['node_modules']);
    assert.match(verdict.violations[0]!.reason, /remplacé|redirigé|supprimé/);
  });

  test('(2) redirigé vers une autre cible : refusé, une seule violation', () => {
    const elsewhere = join(dir, 'autres-deps');
    mkdirSync(elsewhere, { recursive: true });
    unlinkSync(join(ws.path, 'node_modules'));
    symlinkSync(elsewhere, join(ws.path, 'node_modules'), 'dir');

    const diff = captureDiff(ws);
    assert.ok(diff.filesAdded.includes('node_modules'), 'altéré, il reste dans le diff');
    const verdict = auditWorkspace(ws, diff, ['fixture']);
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['node_modules']);
  });

  test('(2) supprimé : refusé', () => {
    editInScope();
    unlinkSync(join(ws.path, 'node_modules'));
    const verdict = audit();
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['node_modules']);
  });

  test('(2) remplacé par un fichier : refusé', () => {
    unlinkSync(join(ws.path, 'node_modules'));
    writeFileSync(join(ws.path, 'node_modules'), 'pas un lien\n', 'utf8');
    const verdict = audit();
    assert.equal(verdict.clean, false);
    assert.ok(verdict.violations.some((v) => v.path === 'node_modules'));
  });

  test('(2) un lien que le runner n’a pas posé n’est jamais exempté', () => {
    // Un workspace sans trace du lien — reconstruit, ou dont le lien préexistait :
    // le même `node_modules`, à la même cible, redevient un chemin ordinaire.
    const { linkedNodeModules: _, ...bare } = ws;
    const diff = captureDiff(bare);
    assert.ok(diff.filesAdded.includes('node_modules'));
    const verdict = auditWorkspace(bare, diff, ['fixture']);
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['node_modules']);
  });

  test('(2) l’exemption vaut pour la racine seulement, pas pour un node_modules imbriqué', () => {
    // Même nom, même cible, mais posé par le modèle dans un chemin autorisé.
    symlinkSync(join(repoRoot, 'node_modules'), join(ws.path, 'fixture', 'node_modules'), 'dir');
    const verdict = audit();
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['fixture/node_modules']);
  });

  test('(3) les autres gardes restent entières à côté d’un lien intact', () => {
    editInScope();
    writeFileSync(join(ws.path, 'README.md'), '# réécrit hors périmètre\n', 'utf8');
    symlinkSync(join(repoRoot, '.env'), join(ws.path, 'fixture', 'lien.txt'));

    const verdict = audit();
    assert.equal(verdict.clean, false);
    const paths = verdict.violations.map((v) => v.path).sort();
    assert.deepEqual(paths, ['README.md', 'fixture/lien.txt']);
    const lien = verdict.violations.find((v) => v.path === 'fixture/lien.txt')!;
    assert.match(lien.reason, /\.env|hors de l’espace/, 'un lien vers le secret, même dans le périmètre');
    assert.ok(!paths.includes('node_modules'), 'le lien intact ne s’ajoute pas aux violations');
  });

  test('(3) déclarer node_modules autorisé ne rouvre pas un lien redirigé', () => {
    // Déclarer `node_modules` autorisé ne sert à rien : le lien sort du worktree.
    unlinkSync(join(ws.path, 'node_modules'));
    const elsewhere = join(dir, 'autres-deps');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(ws.path, 'node_modules'), 'dir');
    const verdict = auditWorkspace(ws, captureDiff(ws), ['fixture', 'node_modules']);
    assert.equal(verdict.clean, false);
  });

  test('retirer le worktree ne suit pas le lien', () => {
    removeWorkspace(repoRoot, ws);
    assert.ok(existsSync(join(repoRoot, 'node_modules', 'dep', 'index.js')));
  });
});

describe('un fichier créé dans un dossier neuf', () => {
  test('apparaît sous son propre chemin, et l’audit l’accepte quand il est autorisé', () => {
    mkdirSync(join(ws.path, 'docs', 'neuf'), { recursive: true });
    writeFileSync(join(ws.path, 'docs', 'neuf', 'note.md'), 'une ligne\n', 'utf8');
    const diff = captureDiff(ws);
    assert.deepEqual(diff.filesAdded, ['docs/neuf/note.md']);
    assert.match(diff.diff, /\+une ligne/);
    assert.deepEqual(auditWorkspace(ws, diff, ['docs/neuf/note.md']), { clean: true, violations: [] });
  });

  test('un fichier non autorisé dans le même dossier neuf reste refusé', () => {
    mkdirSync(join(ws.path, 'docs', 'neuf'), { recursive: true });
    writeFileSync(join(ws.path, 'docs', 'neuf', 'note.md'), 'une ligne\n', 'utf8');
    writeFileSync(join(ws.path, 'docs', 'neuf', 'intrus.md'), 'hors périmètre\n', 'utf8');
    const verdict = auditWorkspace(ws, captureDiff(ws), ['docs/neuf/note.md']);
    assert.equal(verdict.clean, false);
    assert.deepEqual(verdict.violations.map((v) => v.path), ['docs/neuf/intrus.md']);
  });
});
