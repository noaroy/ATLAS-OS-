/**
 * Ce que le contrôle de mise en production peut dire sans se tromper.
 *
 * Trois questions que `atlas:production-check` confondait, et qui se répondent
 * séparément :
 *
 *   · le daemon : un tour ouvert est-il un daemon qui tourne, ou un daemon
 *     mort qui n'a pas pu consigner son arrêt ? Le battement de cœur tranche ;
 *   · le déploiement : les artefacts réellement utilisés — Compose, Dockerfile,
 *     guide opérateur — disent-ils redémarrage, santé, volume, secrets,
 *     sauvegarde ? On lit ce qu'ils déclarent, pas un plan d'avant Docker ;
 *   · le résumé : « prêt » pour quoi ? Le logiciel, la définition du
 *     déploiement, l'instance vivante qu'on observe (ou pas d'ici), et les
 *     intégrations externes qui attendent une main humaine.
 *
 * Tout ici est pur et déterministe : des entrées lues ailleurs, des verdicts
 * rendus ici, testables sans base ni conteneur.
 */

// ─── Le daemon ───────────────────────────────────────────────────────────────

export interface DaemonRunView {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  stopReason?: string | null;
  lastHeartbeatAt: string | null;
  pid: number;
  host: string;
}

export type DaemonRunState = 'RUNNING' | 'STOPPED_CLEANLY' | 'STALE_OPEN' | 'NEVER_RAN';

/** Cinq minutes : le daemon bat à chaque tour, et un tour d'attente dure une minute au plus. */
export const DAEMON_STALE_AFTER_MS = 5 * 60_000;

/**
 * Le dernier tour du daemon, lu comme il faut.
 *
 *   RUNNING          ouvert, battement récent — le daemon tourne, ici et
 *                    maintenant. Ce n'est pas un défaut de journal : c'est
 *                    le journal qui dit « en cours ».
 *   STOPPED_CLEANLY  fermé, avec sa raison. Si un tour plus ancien avait été
 *                    fermé par le démarrage suivant (« arrêt non consigné »),
 *                    le détail le dit : la reprise a réparé, comme prévu.
 *   STALE_OPEN       ouvert, sans battement depuis trop longtemps — un
 *                    processus mort sans consigner. Le prochain démarrage le
 *                    fermera ; d'ici là, aucun daemon ne tourne sur cette base.
 *   NEVER_RAN        aucun tour sur cette base.
 *
 * Relevé sur le VPS : le contrôle lisait « run laissé ouvert : une reprise le
 * croirait vivant » devant un daemon bien vivant. Le tour était ouvert parce
 * que le daemon tournait.
 */
export function classifyDaemonRun(
  runs: readonly DaemonRunView[],
  now: Date,
  staleAfterMs = DAEMON_STALE_AFTER_MS,
): { state: DaemonRunState; detail: string; repairedPrevious: boolean } {
  const [last, previous] = runs;
  if (!last) return { state: 'NEVER_RAN', detail: 'jamais lancé sur cette base — npm run atlas:daemon-check', repairedPrevious: false };
  const repairedPrevious = Boolean(previous?.stopReason && /non consign/i.test(previous.stopReason));
  const quand = (iso: string) => iso.slice(0, 19).replace('T', ' ');
  if (last.stoppedAt) {
    return {
      state: 'STOPPED_CLEANLY',
      detail: `dernier arrêt ${quand(last.stoppedAt)}${last.stopReason ? ` (${last.stopReason})` : ''}${repairedPrevious ? ' · un arrêt non consigné plus ancien a été fermé au démarrage suivant' : ''}`,
      repairedPrevious,
    };
  }
  const battement = last.lastHeartbeatAt ?? last.startedAt;
  const ageMs = now.getTime() - Date.parse(battement);
  if (Number.isFinite(ageMs) && ageMs <= staleAfterMs) {
    const secondes = Math.max(0, Math.round(ageMs / 1000));
    return {
      state: 'RUNNING',
      detail: `en cours : pid ${last.pid} sur ${last.host}, démarré ${quand(last.startedAt)}, battement il y a ${secondes} s${repairedPrevious ? ' · a fermé un arrêt non consigné au démarrage' : ''}`,
      repairedPrevious,
    };
  }
  const minutes = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
  return {
    state: 'STALE_OPEN',
    detail: `tour ouvert sans battement depuis ${minutes === null ? '?' : `${minutes} min`} (pid ${last.pid} sur ${last.host}) : processus mort sans consigner l’arrêt — aucun daemon ne tourne sur cette base ; le prochain démarrage le fermera (« arrêt non consigné »)`,
    repairedPrevious,
  };
}

// ─── Le déploiement, d'après ses artefacts ───────────────────────────────────

export interface DeploymentArtefacts {
  /** deployment/docker-compose.yml, ou null s'il est absent. */
  compose: string | null;
  /** deployment/Dockerfile, ou null. */
  dockerfile: string | null;
  /** docs/OPERATOR.md, ou null. */
  operatorGuide: string | null;
}

export interface EvidenceItem {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Le bloc d'un service dans un fichier Compose : de sa ligne `  nom:` jusqu'à
 * la prochaine clé d'indentation inférieure ou égale. Lu ligne à ligne, fins
 * de ligne normalisées — le fichier arrive en CRLF sur un poste Windows.
 */
function serviceBlock(compose: string, service: string): string | null {
  const lines = compose.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('   ') && !line.startsWith('  #')) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Les preuves de déploiement, lues dans ce qui déploie vraiment.
 *
 * Chaque ligne est un fait tiré du fichier, jamais une supposition : un
 * `restart:` déclaré, un `HEALTHCHECK` écrit, un volume nommé monté sur /data,
 * un `env_file` qui garde les secrets hors de l'image, un guide qui parle de
 * sauvegarde et de restauration. Un fichier absent est un fait aussi.
 */
export function deploymentEvidence(a: DeploymentArtefacts): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (!a.compose) {
    items.push({ name: 'compose', ok: false, detail: 'deployment/docker-compose.yml absent' });
  } else {
    const atlas = serviceBlock(a.compose, 'atlas') ?? '';
    const searxng = serviceBlock(a.compose, 'searxng') ?? '';
    const cli = serviceBlock(a.compose, 'atlas-cli') ?? '';
    items.push({ name: 'service atlas', ok: atlas.length > 0, detail: atlas ? 'déclaré dans docker-compose.yml' : 'service atlas absent du fichier Compose' });
    const restart = /restart:\s*(unless-stopped|always)/.exec(atlas)?.[1] ?? null;
    items.push({ name: 'redémarrage atlas', ok: restart !== null, detail: restart ? `restart: ${restart}` : 'aucune politique de redémarrage sur atlas' });
    const volume = /-\s*atlas-data:\/data\b/.test(atlas) && /ATLAS_DATA_DIR:\s*\/data\b/.test(atlas);
    items.push({ name: 'base persistante', ok: volume, detail: volume ? 'volume nommé atlas-data monté sur /data, ATLAS_DATA_DIR=/data' : 'la base n’est pas sur un volume nommé monté en /data' });
    const envFile = /env_file:\s*\.\.\/\.env/.test(atlas);
    items.push({ name: 'secrets hors image', ok: envFile, detail: envFile ? 'env_file: ../.env — lu au démarrage, jamais copié dans l’image' : 'aucun env_file sur atlas' });
    const health = /healthcheck:/.test(searxng);
    items.push({ name: 'santé searxng', ok: health, detail: health ? 'healthcheck déclaré, atlas attend service_healthy' : 'aucun healthcheck sur searxng' });
    const cliOk = cli.length > 0 && /-\s*atlas-data:\/data\b/.test(cli) && !/\n\s+ports:/.test(cli) && /restart:\s*"?no"?/.test(cli);
    items.push({ name: 'outils sur la même base', ok: cliOk, detail: cliOk ? 'atlas-cli : même volume, aucun port, aucun redémarrage' : 'atlas-cli absent ou mal isolé' });
  }
  if (!a.dockerfile) {
    items.push({ name: 'image', ok: false, detail: 'deployment/Dockerfile absent' });
  } else {
    const health = /^HEALTHCHECK\b/m.test(a.dockerfile);
    const user = /^USER node\b/m.test(a.dockerfile);
    items.push({ name: 'santé du conteneur', ok: health, detail: health ? 'HEALTHCHECK sur /healthz dans le Dockerfile' : 'aucun HEALTHCHECK dans le Dockerfile' });
    items.push({ name: 'utilisateur non root', ok: user, detail: user ? 'USER node' : 'le conteneur tourne en root' });
  }
  if (!a.operatorGuide) {
    items.push({ name: 'guide opérateur', ok: false, detail: 'docs/OPERATOR.md absent' });
  } else {
    const text = a.operatorGuide.toLowerCase();
    const sujets: Array<[string, RegExp]> = [
      ['atlas-cli', /atlas-cli\.sh/],
      ['sauvegarde', /npm run backup|backup/],
      ['restauration', /restore-check/],
      ['contrôle vps', /vps-check/],
      ['tunnel ou reverse proxy', /tunnel ssh|caddy/],
      ['interrupteur d’envoi', /atlas_outbound_enabled/],
      ['mise à jour et retour', /retour|rollback|revenir en arri/],
    ];
    const manquants = sujets.filter(([, re]) => !re.test(text)).map(([n]) => n);
    items.push({
      name: 'guide opérateur',
      ok: manquants.length === 0,
      detail: manquants.length === 0 ? 'docs/OPERATOR.md : atlas-cli, sauvegarde, restauration, vps-check, accès, envoi, retour en arrière' : `docs/OPERATOR.md incomplet : ${manquants.join(', ')}`,
    });
  }
  return items;
}

// ─── Le résumé ───────────────────────────────────────────────────────────────

export type CheckVerdict = 'PASS' | 'FAIL' | 'MANUAL_ACTION_REQUIRED' | 'POST_DEPLOYMENT' | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface CheckLine { area: string; verdict: CheckVerdict; name: string; detail: string }

/** Les aires qui parlent du déploiement, et non du logiciel. */
export const DEPLOYMENT_AREAS: ReadonlySet<string> = new Set(['DEPLOYMENT', 'LINUX COMPATIBILITY']);
/** L'aire qui observe l'instance vivante. */
export const LIVE_AREA = 'LIVE DEPLOYMENT';

export type LiveContext =
  | { kind: 'docker-cli' }
  | { kind: 'local'; serverReachable: boolean }
  | { kind: 'unknown' };

export interface ReadinessSummary {
  software: 'READY' | 'NOT_READY';
  softwareBlockers: number;
  deployment: 'READY' | 'NOT_READY';
  deploymentBlockers: number;
  live: 'HEALTHY' | 'DEGRADED' | 'LOCAL_INSTANCE' | 'NOT_OBSERVABLE_HERE';
  liveDetail: string;
  integrationsPending: number;
  unknowns: number;
}

/**
 * Quatre réponses, quatre questions — et aucune affirmation que le contrôle ne
 * peut pas fonder.
 *
 * « Prêt à acheter un VPS » et « NOT_DEPLOYED » étaient les verdicts d'avant le
 * serveur. Lus depuis le conteneur outils d'un VPS sain, ils étaient faux :
 * le déploiement existait, le contrôle tournait dedans. Désormais l'instance
 * vivante n'est jugée que là où on la voit (le contexte Docker), et ailleurs
 * on dit qu'on ne la voit pas.
 */
export function summariseReadiness(checks: readonly CheckLine[], context: LiveContext): ReadinessSummary {
  const software = checks.filter((c) => !DEPLOYMENT_AREAS.has(c.area) && c.area !== LIVE_AREA);
  const deployment = checks.filter((c) => DEPLOYMENT_AREAS.has(c.area));
  const live = checks.filter((c) => c.area === LIVE_AREA);
  const softwareBlockers = software.filter((c) => c.verdict === 'FAIL').length;
  const unknowns = checks.filter((c) => c.verdict === 'UNKNOWN').length;
  // Un « je ne sais pas » sur le logiciel bloque le logiciel ; sur l'instance
  // vivante (une table des montages illisible), il se lit dans LIVE, pas ici.
  const softwareUnknowns = software.filter((c) => c.verdict === 'UNKNOWN').length;
  const deploymentBlockers = deployment.filter((c) => c.verdict === 'FAIL').length;
  const integrationsPending = checks.filter((c) => c.verdict === 'MANUAL_ACTION_REQUIRED').length;

  let liveState: ReadinessSummary['live'];
  let liveDetail: string;
  if (context.kind === 'docker-cli') {
    const failed = live.filter((c) => c.verdict === 'FAIL');
    liveState = failed.length === 0 && live.length > 0 ? 'HEALTHY' : 'DEGRADED';
    liveDetail = failed.length === 0
      ? `observé depuis le conteneur outils : ${live.map((c) => c.name).join(', ') || 'rien'}`
      : `observé depuis le conteneur outils — ${failed.map((c) => `${c.name} : ${c.detail}`).join(' · ')}`;
  } else if (context.kind === 'local' && context.serverReachable) {
    liveState = 'LOCAL_INSTANCE';
    liveDetail = 'un serveur répond sur cette machine : instance locale, pas le VPS';
  } else {
    liveState = 'NOT_OBSERVABLE_HERE';
    liveDetail = 'le VPS ne se voit pas d’ici : lancer ce contrôle par atlas-cli (bash deployment/atlas-cli.sh production-check)';
  }

  return {
    software: softwareBlockers === 0 && softwareUnknowns === 0 ? 'READY' : 'NOT_READY',
    softwareBlockers,
    deployment: deploymentBlockers === 0 ? 'READY' : 'NOT_READY',
    deploymentBlockers,
    live: liveState,
    liveDetail,
    integrationsPending,
    unknowns,
  };
}
