import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '@atlas/core';
import { createRepositories } from '@atlas/data';
import { classifyDaemonRun, deploymentEvidence, summariseReadiness, DAEMON_STALE_AFTER_MS, type CheckLine } from '../src/readiness.ts';

/**
 * Ce que le contrôle de mise en production dit du daemon, du déploiement et
 * de l'état « prêt » — et ce qu'il ne dit plus.
 *
 * Relevé sur le VPS (v4.4.1) : trois FAIL devant un déploiement sain. Le tour
 * du daemon, ouvert parce que le daemon tournait ; le plan de déploiement,
 * cherché dans un document d'avant Docker ; et « READY FOR VPS PURCHASE = NO »
 * lu depuis le VPS lui-même. Ici, les quatre états du daemon, les preuves
 * tirées des artefacts réels, et un résumé qui ne prétend rien d'invisible.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const logger = createLogger({ level: 'error', pretty: false });
const iso = (t: number) => new Date(t).toISOString();

describe('le tour du daemon, lu comme il faut', () => {
  const now = new Date('2026-09-19T10:00:00.000Z');
  const base = { id: 'dmn_1', pid: 42, host: 'atlas', startedAt: iso(now.getTime() - 3_600_000) };

  test('1. tour courant actif : ouvert, battement récent → RUNNING (pas un défaut de journal)', () => {
    const r = classifyDaemonRun([{ ...base, stoppedAt: null, lastHeartbeatAt: iso(now.getTime() - 40_000) }], now);
    assert.equal(r.state, 'RUNNING');
    assert.match(r.detail, /en cours : pid 42 sur atlas/);
    assert.match(r.detail, /battement il y a 40 s/);
  });

  test('2. ancien tour proprement terminé → STOPPED_CLEANLY, avec sa raison', () => {
    const r = classifyDaemonRun([{ ...base, stoppedAt: iso(now.getTime() - 600_000), stopReason: 'arrêt demandé', lastHeartbeatAt: iso(now.getTime() - 601_000) }], now);
    assert.equal(r.state, 'STOPPED_CLEANLY');
    assert.match(r.detail, /arrêt demandé/);
    assert.equal(r.repairedPrevious, false);
  });

  test('3. ancien tour laissé ouvert après un crash : sans battement depuis longtemps → STALE_OPEN', () => {
    const r = classifyDaemonRun([{ ...base, stoppedAt: null, lastHeartbeatAt: iso(now.getTime() - 20 * 60_000) }], now);
    assert.equal(r.state, 'STALE_OPEN');
    assert.match(r.detail, /sans battement depuis 20 min/);
    assert.match(r.detail, /arrêt non consigné/);
  });

  test('4. le redémarrage répare : le tour courant bat, le précédent a été fermé « arrêt non consigné »', () => {
    const r = classifyDaemonRun([
      { id: 'dmn_2', pid: 77, host: 'atlas', startedAt: iso(now.getTime() - 120_000), stoppedAt: null, lastHeartbeatAt: iso(now.getTime() - 10_000) },
      { ...base, stoppedAt: iso(now.getTime() - 120_000), stopReason: 'arrêt non consigné : reprise par un nouveau daemon', lastHeartbeatAt: iso(now.getTime() - 3_000_000) },
    ], now);
    assert.equal(r.state, 'RUNNING');
    assert.equal(r.repairedPrevious, true);
    assert.match(r.detail, /a fermé un arrêt non consigné/);
  });

  test('la limite : un battement à la seconde près de cinq minutes est encore vivant ; sans battement, la date de démarrage compte', () => {
    assert.equal(classifyDaemonRun([{ ...base, stoppedAt: null, lastHeartbeatAt: iso(now.getTime() - DAEMON_STALE_AFTER_MS) }], now).state, 'RUNNING');
    assert.equal(classifyDaemonRun([{ ...base, stoppedAt: null, lastHeartbeatAt: iso(now.getTime() - DAEMON_STALE_AFTER_MS - 1_000) }], now).state, 'STALE_OPEN');
    assert.equal(classifyDaemonRun([{ ...base, startedAt: iso(now.getTime() - 30_000), stoppedAt: null, lastHeartbeatAt: null }], now).state, 'RUNNING', 'vient de démarrer, pas encore battu');
    assert.equal(classifyDaemonRun([], now).state, 'NEVER_RAN');
  });

  test('crash puis redémarrage, sur la vraie base : la séquence se lit dans daemon_runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-daemon-runs-'));
    const repos = createRepositories(join(dir, 'atlas.db'), logger);
    try {
      // Un daemon démarre et bat.
      const a = repos.tasks.startDaemonRun('atlas', 42);
      repos.tasks.heartbeatDaemonRun(a);
      const t0 = new Date();
      assert.equal(classifyDaemonRun(repos.tasks.daemonRuns(2), t0).state, 'RUNNING');
      // Il meurt sans consigner : dix minutes plus tard, son tour est toujours ouvert.
      const plusTard = new Date(t0.getTime() + 10 * 60_000);
      assert.equal(classifyDaemonRun(repos.tasks.daemonRuns(2), plusTard).state, 'STALE_OPEN');
      // Un nouveau daemon démarre : il ferme le tour orphelin, comme `boot()` le fait.
      const b = repos.tasks.startDaemonRun('atlas', 77);
      assert.equal(repos.tasks.closeStaleDaemonRuns(b), 1);
      repos.tasks.heartbeatDaemonRun(b);
      const apres = classifyDaemonRun(repos.tasks.daemonRuns(2), new Date());
      assert.equal(apres.state, 'RUNNING');
      assert.equal(apres.repairedPrevious, true);
      const [dernier, precedent] = repos.tasks.daemonRuns(2);
      assert.equal(dernier?.id, b);
      assert.equal(precedent?.id, a);
      assert.match(precedent?.stopReason ?? '', /non consigné/);
      // Puis il s'arrête proprement.
      repos.tasks.stopDaemonRun(b, 'arrêt demandé');
      assert.equal(classifyDaemonRun(repos.tasks.daemonRuns(2), new Date()).state, 'STOPPED_CLEANLY');
    } finally {
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('les preuves de déploiement, lues dans les artefacts réels', () => {
  const artefacts = {
    compose: readFileSync(join(ROOT, 'deployment', 'docker-compose.yml'), 'utf8'),
    dockerfile: readFileSync(join(ROOT, 'deployment', 'Dockerfile'), 'utf8'),
    operatorGuide: readFileSync(join(ROOT, 'docs', 'OPERATOR.md'), 'utf8'),
  };

  test('le dépôt tel qu’il est : chaque preuve est établie', () => {
    const items = deploymentEvidence(artefacts);
    const manquantes = items.filter((i) => !i.ok);
    assert.deepEqual(manquantes, [], manquantes.map((i) => `${i.name}: ${i.detail}`).join('\n'));
    assert.ok(items.some((i) => i.name === 'redémarrage atlas' && /unless-stopped/.test(i.detail)));
    assert.ok(items.some((i) => i.name === 'base persistante' && /atlas-data/.test(i.detail)));
  });

  test('les fins de ligne CRLF ne changent rien', () => {
    const crlf = { ...artefacts, compose: artefacts.compose.replace(/\n/g, '\r\n') };
    assert.deepEqual(deploymentEvidence(crlf).filter((i) => !i.ok), []);
  });

  test('un Compose sans redémarrage ni volume : les preuves manquent, nommément', () => {
    const compose = [
      'name: atlas-os', 'services:', '  atlas:', '    image: atlas-os:1.0.0', '    env_file: ../.env', '  searxng:', '    image: searxng/searxng', '',
    ].join('\n');
    const items = deploymentEvidence({ ...artefacts, compose });
    const nom = (n: string) => items.find((i) => i.name === n)!;
    assert.equal(nom('service atlas').ok, true);
    assert.equal(nom('redémarrage atlas').ok, false);
    assert.equal(nom('base persistante').ok, false);
    assert.equal(nom('secrets hors image').ok, true);
    assert.equal(nom('santé searxng').ok, false);
    assert.equal(nom('outils sur la même base').ok, false);
  });

  test('artefacts absents : des faits, pas des suppositions', () => {
    const items = deploymentEvidence({ compose: null, dockerfile: null, operatorGuide: null });
    assert.deepEqual(items.map((i) => [i.name, i.ok]), [['compose', false], ['image', false], ['guide opérateur', false]]);
  });
});

describe('le résumé : cinq réponses, aucune affirmation invisible', () => {
  const line = (area: string, verdict: CheckLine['verdict'], name = 'x', category?: CheckLine['category']): CheckLine => ({ area, verdict, name, detail: '', ...(category ? { category } : {}) });

  test('logiciel validé, Gmail en attente, aucune campagne encore : READY · READY · HEALTHY · ACTION_REQUIRED (Gmail) · NOT_YET_OBSERVED (registre, réponses)', () => {
    const r = summariseReadiness([
      line('CORE', 'PASS', 'file'), line('SECURITY', 'PASS', 'garde'),
      line('AI ORCHESTRATION', 'PASS', 'mode IA', 'OPERATIONAL_CONFIRMATION'),
      line('GMAIL AUTH', 'MANUAL_ACTION_REQUIRED', 'Gmail', 'EXTERNAL_INTEGRATION'),
      line('SALES', 'NOT_YET_OBSERVED', 'registre global', 'REAL_WORLD_EVIDENCE'),
      line('SALES', 'NOT_YET_OBSERVED', 'suivi des réponses', 'REAL_WORLD_EVIDENCE'),
      line('DEPLOYMENT', 'PASS', 'compose'),
      line('LIVE DEPLOYMENT', 'PASS', 'serveur joignable'), line('LIVE DEPLOYMENT', 'PASS', 'daemon en cours'),
    ], { kind: 'docker-cli' });
    assert.equal(r.software, 'READY');
    assert.deepEqual(r.softwareUnverified, []);
    assert.equal(r.deployment, 'READY');
    assert.equal(r.live, 'HEALTHY');
    assert.equal(r.integrations, 'ACTION_REQUIRED');
    assert.deepEqual(r.integrationsPending, ['Gmail']);
    assert.equal(r.realWorld, 'NOT_YET_OBSERVED');
    assert.deepEqual(r.realWorldMissing, ['registre global', 'suivi des réponses']);
  });

  test('un registre vide ou une réponse jamais reçue ne rend pas le logiciel NOT_READY ; observés, ils passent OBSERVED', () => {
    const vide = summariseReadiness([line('SALES', 'UNKNOWN', 'registre global', 'REAL_WORLD_EVIDENCE'), line('SALES', 'NOT_YET_OBSERVED', 'suivi des réponses', 'REAL_WORLD_EVIDENCE')], { kind: 'unknown' });
    assert.equal(vide.software, 'READY');
    assert.equal(vide.realWorld, 'NOT_YET_OBSERVED');
    const plein = summariseReadiness([line('SALES', 'PASS', 'registre global', 'REAL_WORLD_EVIDENCE'), line('SALES', 'PASS', 'suivi des réponses', 'REAL_WORLD_EVIDENCE')], { kind: 'unknown' });
    assert.equal(plein.realWorld, 'OBSERVED');
    assert.deepEqual(plein.realWorldMissing, []);
  });

  test('une confirmation d’exploitation (ATLAS_AI_LIVE=true) n’est pas une inconnue logicielle ; une épreuve non jouée l’est, et se nomme', () => {
    const confirmation = summariseReadiness([line('AI ORCHESTRATION', 'UNKNOWN', 'mode IA', 'OPERATIONAL_CONFIRMATION')], { kind: 'unknown' });
    assert.equal(confirmation.software, 'READY');
    const epreuve = summariseReadiness([line('DAEMON MAIN DB', 'UNKNOWN', 'daemon sur un instantané'), line('OBSERVABILITY', 'UNKNOWN', 'restauration éprouvée')], { kind: 'unknown' });
    assert.equal(epreuve.software, 'NOT_READY');
    assert.deepEqual(epreuve.softwareUnverified, ['daemon sur un instantané', 'restauration éprouvée']);
  });

  test('depuis le conteneur outils, l’instance vivante se juge : HEALTHY ou DEGRADED avec la raison', () => {
    const ok = summariseReadiness([line('CORE', 'PASS'), line('DEPLOYMENT', 'PASS'), line('LIVE DEPLOYMENT', 'PASS', 'serveur joignable'), line('LIVE DEPLOYMENT', 'PASS', 'daemon en cours')], { kind: 'docker-cli' });
    assert.equal(ok.live, 'HEALTHY');
    assert.equal(ok.software, 'READY');
    assert.equal(ok.deployment, 'READY');
    const ko = summariseReadiness([line('LIVE DEPLOYMENT', 'FAIL', 'daemon en cours')], { kind: 'docker-cli' });
    assert.equal(ko.live, 'DEGRADED');
    assert.match(ko.liveDetail, /daemon en cours/);
  });

  test('hors conteneur : NOT_OBSERVABLE_HERE, ou LOCAL_INSTANCE si un serveur local répond — jamais « NOT_DEPLOYED »', () => {
    assert.equal(summariseReadiness([], { kind: 'unknown' }).live, 'NOT_OBSERVABLE_HERE');
    assert.equal(summariseReadiness([], { kind: 'local', serverReachable: false }).live, 'NOT_OBSERVABLE_HERE');
    assert.equal(summariseReadiness([], { kind: 'local', serverReachable: true }).live, 'LOCAL_INSTANCE');
  });

  test('le logiciel et le déploiement se comptent à part ; N/A et MANUEL ne bloquent pas ; UNKNOWN bloque le logiciel', () => {
    const r = summariseReadiness([
      line('ENGINEERING', 'NOT_APPLICABLE'), line('GMAIL AUTH', 'MANUAL_ACTION_REQUIRED'), line('CORE', 'PASS'),
      line('DEPLOYMENT', 'FAIL'), line('LIVE DEPLOYMENT', 'FAIL'),
    ], { kind: 'docker-cli' });
    assert.equal(r.software, 'READY');
    assert.equal(r.softwareBlockers, 0);
    assert.equal(r.deployment, 'NOT_READY');
    assert.equal(r.deploymentBlockers, 1);
    assert.equal(r.integrations, 'ACTION_REQUIRED');
    assert.deepEqual(r.integrationsPending, ['x']);
    const inconnu = summariseReadiness([line('OBSERVABILITY', 'UNKNOWN')], { kind: 'unknown' });
    assert.equal(inconnu.software, 'NOT_READY');
    assert.equal(inconnu.unknowns, 1);
    const inconnuLive = summariseReadiness([line('CORE', 'PASS'), line('LIVE DEPLOYMENT', 'UNKNOWN', 'base sur le volume')], { kind: 'docker-cli' });
    assert.equal(inconnuLive.software, 'READY', 'un inconnu sur l’instance vivante ne bloque pas le logiciel');
    assert.equal(inconnuLive.live, 'HEALTHY', 'seul un FAIL dégrade ; l’inconnu reste affiché « ? »');
  });
});

describe('le script atlas-production-check ne porte plus les verdicts d’avant le serveur', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'atlas-production-check.ts'), 'utf8');
  test('plus de plan systemd, plus de « prêt à acheter », plus de NOT_DEPLOYED ; git sondé avant d’être appelé', () => {
    assert.ok(!/vps-deployment\.md/.test(source));
    assert.ok(!/READY FOR VPS PURCHASE/.test(source));
    assert.ok(!/NOT_DEPLOYED/.test(source));
    assert.match(source, /spawnSync\('git', \['--version'\]/);
    assert.match(source, /NOT_APPLICABLE/);
    assert.match(source, /classifyDaemonRun\(repos\.tasks\.daemonRuns\(2\)/);
    assert.match(source, /deploymentEvidence\(/);
    assert.match(source, /summariseReadiness\(checks, liveContext\)/);
  });

  test('les cinq anciennes inconnues sont classées : deux preuves du monde réel, une confirmation, deux épreuves jouables par atlas-cli sur instantané', () => {
    assert.match(source, /'registre global', ledger\.length > 0 \? 'PASS' : 'NOT_YET_OBSERVED'[\s\S]{0,300}'REAL_WORLD_EVIDENCE'/);
    assert.match(source, /'suivi des réponses', conversations\.length > 0 \? 'PASS' : 'NOT_YET_OBSERVED'[\s\S]{0,300}'REAL_WORLD_EVIDENCE'/);
    assert.match(source, /'mode IA', 'PASS'[\s\S]{0,400}'OPERATIONAL_CONFIRMATION'/);
    assert.match(source, /atlas-cli\.sh daemon-check/);
    assert.match(source, /atlas-cli\.sh restore-check/);
    const daemonCheck = readFileSync(join(ROOT, 'scripts', 'daemon-main-db-check.ts'), 'utf8');
    assert.match(daemonCheck, /snapshotDatabase\(sourcePath, dbPath\)/, 'le daemon d’épreuve tourne sur un instantané, jamais sur la source');
    const restoreCheck = readFileSync(join(ROOT, 'scripts', 'restore-check.ts'), 'utf8');
    assert.match(restoreCheck, /createRepositories\(config\.paths\.databaseFile, logger, \{ readonly: true \}\)/, 'la source est ouverte en lecture seule');
    assert.match(restoreCheck, /await source\.db\.backup\(fresh\)/, 'l’instantané vient de la même connexion, dans la même transaction de lecture');
    assert.ok(!/statSync\(config\.paths\.databaseFile\)\.size === /.test(restoreCheck) && !/mainBefore\.size === mainAfter\.size/.test(restoreCheck), 'plus de comparaison de taille de fichier sur une base vivante');
    const wrapper = readFileSync(join(ROOT, 'deployment', 'atlas-cli.sh'), 'utf8');
    assert.match(wrapper, /daemon-check\)\s+printf 'atlas:daemon-check'/);
  });

  test('le Dockerfile embarque les artefacts que le contrôle lit, sans le fichier privé', () => {
    const df = readFileSync(join(ROOT, 'deployment', 'Dockerfile'), 'utf8');
    const cli = df.slice(df.indexOf('AS cli'), df.indexOf('AS runtime'));
    assert.match(cli, /COPY --from=build \/build\/deployment \.\/deployment/);
    assert.match(cli, /COPY --from=build \/build\/docs \.\/docs/);
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    assert.ok(ignore.includes('deployment/docker-compose.private.yml'));
  });
});
