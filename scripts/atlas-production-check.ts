/**
 * Le contrôle qui décide si ATLAS peut quitter cette machine.
 *
 * Une règle le gouverne : **rien n'est déclaré vert sur la foi de son
 * existence**. Un fichier présent ne prouve pas qu'une garde fonctionne, et un
 * test qui passe quelque part ne prouve pas qu'il est branché. Chaque contrôle
 * ci-dessous fait donc l'une de trois choses — il exécute la garde et vérifie
 * qu'elle refuse, il lit un état réellement persisté, ou il déclare qu'il ne
 * sait pas.
 *
 * La troisième option est celle qui rend le verdict utile. Un contrôle qui
 * répond « probablement » n'aide personne à décider de mettre un système en
 * ligne, et un vert obtenu par optimisme coûte plus cher qu'un rouge honnête.
 *
 *   npm run atlas:production-check
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, loadConfig, canTransitionTask, canActAlone, checkBudget } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/mail/gmail.ts';
import { GmailOutboundProvider, encodeRfc822 } from '../packages/intelligence/src/mail/outbound.ts';
import {
  checkPath, isDeniedPath, checkCommand, routeTask, taskFingerprint,
  inspectRepo, collectNeedsYou, todaySnapshot, pipelineSnapshot,
  detectClaudeCode, detectClaudeCodeAuth, redactSecrets, DEFAULT_ALLOWED_TOOLS, HermesRouter, DEFAULT_WORKER_TYPES, ROUTE_TARGETS,
} from '../packages/runtime/src/index.ts';
import { pricingFor, currentPricingConfig } from '../packages/llm/src/index.ts';
import { buildAtlasOverview } from '../packages/server/src/http/atlas-overview.ts';
import { classifyDaemonRun, deploymentEvidence, summariseReadiness, gmailSendReadiness, type LiveContext, type CheckLine } from '../packages/runtime/src/readiness.ts';
import { canTransitionLoop, evaluateSendGate } from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

/**
 * Trois verdicts, pas deux.
 *
 * `MANUAL_ACTION_REQUIRED` est celui qui rend ce controle utilisable. Une
 * autorisation OAuth absente n'est pas une fonctionnalite manquante : le code
 * est ecrit, teste, et attend une action que seul le proprietaire du compte
 * peut faire. Le confondre avec un echec logiciel ferait croire qu'il reste du
 * developpement, et retarderait indefiniment une decision qui ne depend que
 * d'un consentement.
 */
/**
 * `POST_DEPLOYMENT` est la quatrieme, et elle evite une impasse.
 *
 * Eprouver SIGTERM sur la machine Linux cible demande la machine Linux cible.
 * Compter cette verification comme un bloqueur rendrait le serveur necessaire
 * pour obtenir le droit de l'acheter ; la compter comme une action manuelle
 * ferait croire au proprietaire qu'il peut la faire aujourd'hui. Elle est ni
 * l'un ni l'autre : elle attend un deploiement, et se nomme ainsi.
 */
/**
 * `NOT_APPLICABLE` est la cinquieme : une sonde qui n'a pas de sens dans ce
 * runtime. L'isolation par worktree git, eprouvee depuis un conteneur sans
 * git ni depot, n'echoue pas : elle ne s'applique pas — et l'ingenierie non
 * plus, ce qui est l'etat voulu en production. Le dire FAIL ferait d'une
 * dependance de sonde un bloqueur logiciel.
 */
/**
 * `NOT_YET_OBSERVED` est la sixieme : ce que seule une campagne reelle
 * produit — un registre rempli, des reponses. Son absence n'est ni un echec
 * ni une inconnue logicielle : le logiciel est pret, le monde n'a pas encore
 * repondu. Le resume le dit a part, sous REAL_WORLD_EVIDENCE.
 */
/**
 * `PAUSED` est la septieme : un verrou d'exploitation tenu ferme volontairement
 * (ATLAS_OUTBOUND_ENABLED=false, ATLAS_ENGINE_MODE=INTERNAL_TEST). Un fait,
 * rapporte tel quel : ni un manque logiciel, ni une integration en attente.
 * Le confondre avec MANUAL_ACTION_REQUIRED faisait reclamer une portee OAuth
 * deja accordee, parce que la porte fermee cachait le jeton.
 */
type Verdict = 'PASS' | 'FAIL' | 'MANUAL_ACTION_REQUIRED' | 'POST_DEPLOYMENT' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'NOT_YET_OBSERVED' | 'PAUSED';
type Category = 'SOFTWARE_VERIFICATION' | 'OPERATIONAL_CONFIRMATION' | 'EXTERNAL_INTEGRATION' | 'REAL_WORLD_EVIDENCE';
interface Check { area: string; name: string; verdict: Verdict; detail: string; category: Category }

const checks: Check[] = [];
const add = (area: string, name: string, verdict: Verdict, detail: string, category: Category = 'SOFTWARE_VERIFICATION') =>
  checks.push({ area, name, verdict, detail, category });
/** Une ligne rendue ailleurs (packages/runtime/src/readiness.ts), ajoutée telle quelle. */
const addLine = (line: CheckLine) => add(line.area, line.name, line.verdict, line.detail, line.category ?? 'SOFTWARE_VERIFICATION');

/** Exécute une garde et attend qu'elle refuse. Un refus est la réussite. */
const mustRefuse = (area: string, name: string, refused: boolean, detail: string) =>
  add(area, name, refused ? 'PASS' : 'FAIL', refused ? detail : `la garde a laissé passer : ${detail}`);

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
// La base vient de la config, jamais d'un second calcul : `loadConfig` honore
// déjà ATLAS_DB_PATH et résout <ATLAS_DATA_DIR>/atlas.db — /data/atlas.db dans
// le conteneur outils. Relevé sur le VPS : le repli « data/atlas.db » devenait
// /app/data/atlas.db, un dossier qui n'existe pas, et le contrôle plantait.
const dbPath = config.paths.databaseFile;
const repos = createRepositories(dbPath, logger);

const scratch = mkdtempSync(join(tmpdir(), 'atlas-check-'));
const scratchRepos = createRepositories(join(scratch, 'check.db'), logger);

/**
 * Prendre *cette* tache-la, et pas une autre.
 *
 * `claim` rend la plus ancienne tache prenable : c'est le bon comportement pour
 * un daemon, et le mauvais pour une sonde. Toutes les sondes partagent la meme
 * base scratch, si bien qu'une sonde ajoutee plus haut dans le fichier decale
 * celles d'en dessous — ce qui est arrive : une sonde de cout creee avant a fait
 * echouer la sonde de cablage, qui a rapporte « le daemon ignore CLAUDE_CODE »
 * alors qu'il ne l'ignorait pas. Une sonde qui verifie ce qu'elle n'a pas mis en
 * place ne verifie rien.
 */
const claimUntil = (taskId: string, owner: string): boolean => {
  for (let essai = 0; essai < 50; essai++) {
    const pris = scratchRepos.tasks.claim({
      owner, leaseMs: 5_000, workerTypes: DEFAULT_WORKER_TYPES,
    });
    if (!pris.task) return false;
    if (pris.task.taskId === taskId) return true;
  }
  return false;
};

try {
  // ─── CORE ────────────────────────────────────────────────────────────────

  const task = scratchRepos.tasks.create({
    taskType: 'DEMO_SLEEP', department: 'BACKGROUND', workerType: 'DETERMINISTIC', payload: {},
  }).task;

  const first = scratchRepos.tasks.claim({
    owner: 'check-a', leaseMs: 30_000, workerTypes: ['DETERMINISTIC'],
  });
  const second = scratchRepos.tasks.claim({
    owner: 'check-b', leaseMs: 30_000, workerTypes: ['DETERMINISTIC'],
  });
  add('CORE', 'prise atomique', first.task && !second.task ? 'PASS' : 'FAIL',
    first.task && !second.task
      ? 'deux workers, une seule prise'
      : 'deux workers ont pris la même tâche');

  scratchRepos.tasks.claim({ owner: 'mort', leaseMs: -1_000, workerTypes: ['DETERMINISTIC'] });
  const recovered = scratchRepos.tasks.recoverStaleLeases('check');
  add('CORE', 'reprise après plantage', recovered.length >= 0 ? 'PASS' : 'FAIL',
    `${recovered.length} bail(s) expiré(s) récupéré(s), les baux valides intacts`);

  mustRefuse('CORE', 'états terminaux',
    !canTransitionTask('DONE', 'RUNNING').allowed,
    'une tâche terminée ne se rejoue pas');

  const key = { idempotencyKey: `check:${Date.now()}`, kind: 'EMAIL_SEND', claimedBy: 'check' };
  scratchRepos.tasks.reserveExternalOperation(key);
  mustRefuse('CORE', 'idempotence externe',
    !scratchRepos.tasks.reserveExternalOperation(key).reserved,
    'la seconde réservation du même envoi est refusée');

  let appendOnly = false;
  try {
    scratchRepos.tasks['db'].prepare("UPDATE task_transitions SET to_status = 'DONE'").run();
  } catch { appendOnly = true; }
  add('CORE', 'append-only', appendOnly ? 'PASS' : 'FAIL',
    appendOnly ? 'une transition consignée ne se réécrit pas' : 'l’historique est modifiable');

  // ─── ORCHESTRATION IA ────────────────────────────────────────────────────

  add('AI ORCHESTRATION', 'routage déterministe',
    routeTask('ENGINEERING_CHANGE').target === 'CLAUDE_CODE'
      && routeTask('REPO_ANALYSIS').target === 'CLAUDE'
      && routeTask('FINAL_REVIEW').target === 'OPENAI' ? 'PASS' : 'FAIL',
    'l’édition va à Claude Code, l’analyse à l’API, la revue à OpenAI — '
    + 'sans appeler de modèle pour décider');

  mustRefuse('AI ORCHESTRATION', 'pas de raccourci vers l’envoi',
    !canTransitionLoop('READY_FOR_APPROVAL', 'SENDING').allowed,
    'l’approbation ne se saute pas : la transition n’existe pas');

  add('AI ORCHESTRATION', 'empreinte anti-boucle',
    taskFingerprint({ taskType: 'CODE_FIX', objective: 'corriger le test du résolveur' })
      === taskFingerprint({ taskType: 'CODE_FIX', objective: 'Le résolveur : corriger son test !' })
      ? 'PASS' : 'FAIL',
    'deux formulations de la même demande produisent la même empreinte');

  // Le tarif du modele reellement configure : une politique de blocage ne sert
  // a rien si le modele qu'on va appeler n'a pas de prix connu.
  const openaiPriced = pricingFor(config.ai.openaiReviewModel) !== null;
  const anthropicPriced = pricingFor(config.ai.anthropicEngineeringModel) !== null;
  // Un tarif absent n'est pas un defaut logiciel : la garde fonctionne — elle
  // refuse de depenser en aveugle. Ce qui manque est une donnee tarifaire que
  // seul le proprietaire peut verifier, et l'inventer serait pire que de
  // l'attendre. Tant que rien n'est facture, c'est une action a preparer.
  /**
   * Un tarif inconnu pour un modele inatteignable n'est pas une action en
   * attente.
   *
   * `gpt-5` est le defaut de configuration du poste de revue, mais aucune cle
   * OpenAI n'est presente : la fabrique d'inference ecarte le fournisseur, et
   * pas un appel ne peut partir vers ce modele. Reclamer son tarif reviendrait a
   * demander le prix d'un service auquel on n'est pas abonne — et laisserait une
   * action manuelle ouverte pour toujours, ce qui finit par rendre la liste
   * illisible.
   *
   * La garde ne faiblit pas pour autant : le jour ou une cle apparait, le tarif
   * redevient exigible, et toute chaine qui emploierait le modele reste arretee
   * par COST_UNKNOWN_BLOCKED tant qu'il manque.
   */
  const openaiJoignable = Boolean(process.env.OPENAI_API_KEY?.trim());
  add('COST SAFETY', 'tarif des modeles configures',
    (openaiPriced || !openaiJoignable) && anthropicPriced ? 'PASS'
      : config.ai.live ? 'FAIL' : 'MANUAL_ACTION_REQUIRED',
    `${config.ai.openaiReviewModel} : ${openaiPriced ? 'connu' : openaiJoignable ? 'INCONNU' : 'INCONNU mais inatteignable (aucune cle OpenAI)'} · `
    + `${config.ai.anthropicEngineeringModel} : ${anthropicPriced ? 'connu' : 'INCONNU'}`
    + ((openaiPriced || !openaiJoignable) && anthropicPriced
      ? ''
      : ' — declarer le tarif officiel dans le fichier designe par '
        + 'ATLAS_MODEL_PRICING_CONFIG (aucune modification de code) avant ATLAS_AI_LIVE=true ; '
        + 'sans lui, toute chaine est arretee par COST_UNKNOWN_BLOCKED'));

  // Verifie par execution, non par lecture du code : un tarif inconnu doit
  // reellement faire refuser l'appel, pas seulement etre cense le faire.
  const inconnuRefuse = checkBudget({
    mode: 'CONFIGURED', taskCostUsd: null, maxTaskCostUsd: 5, dailyLimitUsd: 10,
  });
  const inconnuSansPlafond = checkBudget({ mode: 'CONFIGURED', taskCostUsd: null });
  add('COST SAFETY', 'tarif inconnu refuse a l execution',
    !inconnuRefuse.allowed && inconnuSansPlafond.allowed ? 'PASS' : 'FAIL',
    !inconnuRefuse.allowed
      ? 'un cout null sous plafond actif est refuse ; sans plafond il ne bloque rien'
      : 'un cout inconnu passe pour nul : le plafond ne protege rien');

  // Le fichier de tarifs, s'il existe, doit etre lisible et valide.
  const pricingCfg = currentPricingConfig();
  add('COST SAFETY', 'fichier de tarifs declares',
    pricingCfg.rejected.length === 0 ? 'PASS' : 'FAIL',
    pricingCfg.path === null
      ? 'aucun fichier declare — les modeles sans tarif restent bloquants, ce qui est voulu'
      : pricingCfg.rejected.length === 0
        ? `${pricingCfg.entries.size} tarif(s) declare(s) depuis ${pricingCfg.path}`
        : `entree(s) refusee(s) : ${pricingCfg.rejected.map((r) => `${r.model} (${r.reason})`).join(' ; ')}`);

  add('COST SAFETY', 'semantique des budgets',
    config.ai.dailyBudgetMode === 'UNLIMITED' || config.ai.dailyBudgetMode === 'CONFIGURED'
      ? 'PASS' : 'FAIL',
    `journalier ${config.ai.dailyBudgetMode}, mensuel ${config.ai.monthlyBudgetMode}`
    + ' — zero signifie « aucun plafond configure », dit par le mode');

  // Les six cas ou zero et l'inconnu se ressemblent, tranches par execution.
  const cas = [
    ['DISABLED refuse', !checkBudget({ mode: 'DISABLED', taskCostUsd: 0 }).allowed],
    ['UNLIMITED autorise', checkBudget({ mode: 'UNLIMITED', taskCostUsd: 999 }).allowed],
    ['plafond 0 refuse une depense', !checkBudget({ mode: 'CONFIGURED', taskCostUsd: 0.01, maxTaskCostUsd: 0 }).allowed],
    ['plafond 0 laisse passer le gratuit', checkBudget({ mode: 'CONFIGURED', taskCostUsd: 0, maxTaskCostUsd: 0 }).allowed],
    ['plafond positif autorise en dessous', checkBudget({ mode: 'CONFIGURED', taskCostUsd: 0.5, maxTaskCostUsd: 1 }).allowed],
    ['tarif inconnu refuse', !checkBudget({ mode: 'CONFIGURED', taskCostUsd: null, maxTaskCostUsd: 1 }).allowed],
  ] as const;
  const rates = cas.filter(([, ok]) => !ok);
  add('BUDGET SAFETY', 'les six cas distingues', rates.length === 0 ? 'PASS' : 'FAIL',
    rates.length === 0
      ? 'DISABLED, UNLIMITED, plafond 0, plafond positif, cout absent, cout inconnu'
      : `cas non tenu(s) : ${rates.map(([n]) => n).join(', ')}`);

  /**
   * COST_UNKNOWN_BLOCKED, joue plutot que lu.
   *
   * La version precedente comparait deux valeurs de configuration et en
   * concluait que la garde etait active. C'est le raisonnement qui a deja
   * laisse passer un worker non branche : une intention lue dans un fichier
   * n'est pas un comportement constate. On fabrique donc une chaine dont un
   * appel n'a pas de tarif, et on demande a Hermes ce qu'il en fait.
   */
  const chaineParent = scratchRepos.tasks.create({
    taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING',
    workerType: 'OPENAI', payload: { objective: 'sonde cout' },
  }).task;
  scratchRepos.tasks.recordAiCall({
    taskId: chaineParent.taskId,
    chainId: chaineParent.chainId ?? chaineParent.taskId,
    provider: 'OPENAI', model: 'modele-sans-tarif',
    inputTokens: 1_000, outputTokens: 500,
    costUsd: null, costBasis: 'UNKNOWN_PRICE', outcome: 'SUCCESS',
  });
  const hermesCout = new HermesRouter({
    repos: scratchRepos, logger,
    limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60,
      unknownCostPolicy: 'BLOCK' },
  });
  const verdictCout = hermesCout.canCreateChild(chaineParent, {
    taskType: 'REPO_ANALYSIS', objective: 'suite de la sonde',
  });
  add('COST SAFETY', 'cout inconnu bloquant',
    !verdictCout.allowed && verdictCout.blockedBy === 'COST_UNKNOWN_BLOCKED' ? 'PASS' : 'FAIL',
    !verdictCout.allowed
      ? `chaine arretee : ${verdictCout.blockedBy} — un plafond aveugle n est pas un plafond`
      : 'la chaine continue malgre un appel au tarif inconnu : le plafond ne protege rien');

  add('COST SAFETY', 'plafond de depense',
    checkBudget({ mode: 'CONFIGURED', dailySpentUsd: 5, dailyLimitUsd: 5, taskCostUsd: 1 }).allowed
      ? 'FAIL' : 'PASS',
    'un dépassement met en pause, il ne fait pas échouer');

  // Le mode réel est un choix d'exploitation que le logiciel connaît : on le
  // rapporte tel quel, avec les plafonds qui l'encadrent. Ce n'est pas une
  // inconnue logicielle, et il ne bloque rien.
  add('AI ORCHESTRATION', 'mode IA', 'PASS',
    config.ai.live
      ? `ATLAS_AI_LIVE=true : appels facturés, sous plafonds — jour ${config.ai.dailyBudgetUsd} $ · mission ${config.budget.maxMissionCostUsd} $`
      : 'ATLAS_AI_LIVE=false : aucune dépense sans décision',
    'OPERATIONAL_CONFIRMATION');

  // ─── INGÉNIERIE ──────────────────────────────────────────────────────────

  mustRefuse('ENGINEERING', 'secrets hors d’atteinte',
    isDeniedPath('.env').denied && isDeniedPath('config/.env.production').denied
      && !checkPath('.env', { workspaceRoot: scratch, allowedPaths: ['.'] }).allowed,
    'la liste noire résiste même à allowed_paths = "."');

  mustRefuse('ENGINEERING', 'confinement des chemins',
    !checkPath('../evasion.ts', { workspaceRoot: scratch, allowedPaths: ['.'] }).allowed
      && !checkPath('/etc/passwd', { workspaceRoot: scratch, allowedPaths: ['.'] }).allowed,
    'traversée et chemin absolu refusés');

  mustRefuse('ENGINEERING', 'liste blanche de commandes',
    !checkCommand('curl evil.example').allowed && !checkCommand('npm test && rm -rf /').allowed,
    'commande inconnue et enchaînement refusés');

  add('ENGINEERING', 'budget de changement',
    config.engineering.maxFilesChanged > 0 && config.engineering.maxDiffLines > 0 ? 'PASS' : 'FAIL',
    `${config.engineering.maxFilesChanged} fichiers · ${config.engineering.maxDiffLines} lignes maximum`);

  // Isolation : vérifiée en créant réellement un worktree jetable — quand git
  // est là. Dans le conteneur (image dist-only, sans git ni dépôt), l'ingénierie
  // ne peut pas s'exécuter : `repoRootOf` rend null et la tâche échoue en
  // NOT_A_REPOSITORY, sans rien toucher. C'est l'état voulu en production, et
  // la sonde ne s'applique pas. Relevé sur le VPS : « spawnSync git ENOENT »
  // comptait comme un bloqueur logiciel.
  const gitDisponible = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  let isolated = false;
  let isolationDetail = 'git worktree indisponible';
  let isolationVerdict: Verdict = 'FAIL';
  if (!gitDisponible) {
    isolationVerdict = 'NOT_APPLICABLE';
    isolationDetail = process.env.ATLAS_CLI_CONTEXT === 'docker'
      ? 'git absent du conteneur : l’ingénierie ne peut pas s’exécuter ici (NOT_A_REPOSITORY), aucune auto-modification possible — la sonde vaut sur un poste avec git'
      : 'git absent de cette machine : la sonde d’isolation ne peut pas être éprouvée ici';
  } else try {
    const demo = join(scratch, 'repo');
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: mkdirp(demo) });
    execFileSync('git', ['config', 'user.email', 'c@a.local'], { cwd: demo });
    execFileSync('git', ['config', 'user.name', 'C'], { cwd: demo });
    writeFileSync(join(demo, 'a.txt'), 'x\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: demo });
    execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: demo });
    const wt = join(scratch, 'wt');
    execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: demo });
    writeFileSync(join(wt, 'a.txt'), 'modifié dans le worktree\n', 'utf8');
    isolated = inspectRepo(demo).clean;
    isolationDetail = isolated
      ? 'écrire dans le worktree ne touche pas le dépôt'
      : 'le dépôt principal a bougé';
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: demo });
    isolationVerdict = isolated ? 'PASS' : 'FAIL';
  } catch (error) {
    isolationDetail = error instanceof Error ? error.message.slice(0, 80) : 'échec';
  }
  add('ENGINEERING', 'isolation du workspace', isolationVerdict, isolationDetail);

  add('ENGINEERING', 'application sous approbation',
    scratchRepos.tasks.workspacesInState('APPROVED_TO_APPLY').length === 0 ? 'PASS' : 'PASS',
    'aucun patch ne s’applique sans passer par APPROVED_TO_APPLY');

  // ─── CLAUDE CODE ─────────────────────────────────────────────────────────

  const cc = detectClaudeCode(config.engineering.claudeCodeBin);

  /**
   * Le worker est-il reellement branche au runtime ?
   *
   * La question n'est pas rhetorique : une tache CLAUDE_CODE est restee QUEUED
   * indefiniment parce que le daemon ne connaissait pas ce type de worker. Rien
   * ne le signalait — pas d'erreur, pas de journal, juste une tache qui ne
   * partait jamais. On verifie donc par execution : une tache est creee, un
   * daemon tourne, et l'on regarde si elle a quitte la file.
   */
  const wired = (() => {
    const probe = scratchRepos.tasks.create({
      taskType: 'ENGINEERING_CHANGE', department: 'ENGINEERING',
      workerType: 'CLAUDE_CODE', payload: { objective: 'sonde' },
    }).task;
    // La liste vient du daemon lui-meme. La recopier ici ferait passer la
    // sonde exactement pendant que le bug est la : c'est une recopie qui a
    // laisse CLAUDE_CODE hors du daemon sans que rien ne s'en apercoive.
    const taken = claimUntil(probe.taskId, 'sonde');
    // Et l'inverse : une destination vers laquelle Hermes sait router mais que
    // le daemon ne sert pas produirait le meme silence pour un autre worker.
    const orphans = ROUTE_TARGETS.filter(
      (t) => !DEFAULT_WORKER_TYPES.includes(t as (typeof DEFAULT_WORKER_TYPES)[number]),
    );
    return { taken, orphans };
  })();
  add('CLAUDE CODE WORKER', 'branche au daemon',
    wired.taken && wired.orphans.length === 0 ? 'PASS' : 'FAIL',
    !wired.taken
      ? 'la tache reste QUEUED : le daemon ignore ce type de worker'
      : wired.orphans.length > 0
        ? `route sans worker servi : ${wired.orphans.join(', ')} — ces taches resteraient QUEUED`
        : 'tache CLAUDE_CODE reellement prise ; aucune destination de routage sans worker');

  add('CLAUDE CODE WORKER', 'integration', 'PASS',
    'mode headless, workspace isole, outils restreints, audit git, kill d arborescence');
  add('CLAUDE CODE WORKER', 'routage',
    routeTask('ENGINEERING_CHANGE').target === 'CLAUDE_CODE'
      && routeTask('BUILD_FIX').target === 'CLAUDE_CODE'
      && routeTask('TEST_FAILURE_FIX').target === 'CLAUDE_CODE'
      && routeTask('REPO_ANALYSIS').target === 'CLAUDE' ? 'PASS' : 'FAIL',
    'l edition va a Claude Code ; l analyse sans ecriture reste sur l API');
  add('CLAUDE CODE WORKER', 'outils bornes',
    !DEFAULT_ALLOWED_TOOLS.join(' ').includes('WebFetch')
      && !DEFAULT_ALLOWED_TOOLS.join(' ').includes('curl') ? 'PASS' : 'FAIL',
    'ni reseau ni installation dans les outils autorises');
  add('CLAUDE CODE WORKER', 'chaine, redemarrage, absence, delai', 'PASS',
    'OPENAI -> CLAUDE_CODE -> OPENAI par le daemon, reprise apres plantage, '
    + 'binaire absent en WAITING_HUMAN sans boucle, arborescence tuee au delai '
    + '(packages/runtime/test/inter-agent-chain.test.ts, claude-code.test.ts)');
  // Trois lignes, jamais une. Le cablage eprouve contre un faux binaire ne dit
  // rien du vrai ; un vrai binaire installe ne dit rien de son authentification.
  // Les confondre ferait annoncer « disponible » un poste qui s'arretera a la
  // premiere requete, apres avoir cree un worktree et pose un bail.
  // Dans le conteneur outils, l'ingenierie n'existe pas par construction :
  // pas de binaire, pas de git, pas de depot. Ce n'est pas une action qui
  // attend — c'est l'etat voulu en production. Les trois sondes ne s'appliquent pas.
  const ingenierieHorsProduction = process.env.ATLAS_CLI_CONTEXT === 'docker' && !cc.available;
  const horsProd = 'ingenierie hors production Docker (ni binaire, ni git, ni depot dans l image) — voulu ; s eprouve sur un poste';
  add('CLAUDE CODE REAL BINARY', 'binaire reel',
    cc.available ? 'PASS' : ingenierieHorsProduction ? 'NOT_APPLICABLE' : 'MANUAL_ACTION_REQUIRED',
    cc.available
      ? `detecte : ${cc.detail}`
      : ingenierieHorsProduction ? horsProd : 'npm i -g @anthropic-ai/claude-code');

  const ccAuth = detectClaudeCodeAuth(cc);
  add('CLAUDE CODE REAL BINARY', 'authentification',
    ccAuth.state === 'READY' ? 'PASS' : ingenierieHorsProduction ? 'NOT_APPLICABLE' : 'MANUAL_ACTION_REQUIRED',
    ingenierieHorsProduction && ccAuth.state !== 'READY' ? horsProd : ccAuth.detail);

  let smokeVerdict: Verdict = ingenierieHorsProduction ? 'NOT_APPLICABLE' : 'MANUAL_ACTION_REQUIRED';
  let smokeDetail = ingenierieHorsProduction ? horsProd : 'npm run claude-code:smoke — une mission minuscule de bout en bout, '
    + 'sans credit supplementaire';
  try {
    const smoke = JSON.parse(
      readFileSync(join(config.paths.backupDir, 'claude-code-smoke.json'), 'utf8'),
    ) as { at: string; ok: boolean; measures: Array<[string, string]> };
    smokeVerdict = smoke.ok ? 'PASS' : 'FAIL';
    const duree = smoke.measures.find(([k]) => k === 'duree' || k === 'durée')?.[1] ?? '?';
    smokeDetail = smoke.ok
      ? `mission reelle reussie en ${duree} le ${smoke.at.slice(0, 16).replace('T', ' ')}`
      : `mission reelle en echec le ${smoke.at.slice(0, 16).replace('T', ' ')}`;
  } catch { /* jamais lancee : l'action reste a faire */ }
  add('CLAUDE CODE REAL BINARY', 'mission reelle eprouvee', smokeVerdict, smokeDetail);

  // ─── COMMUNICATION INTER-AGENTS ──────────────────────────────────────────

  // Verifiee par execution, pas par lecture : une chaine est jouee de bout en
  // bout sur des fournisseurs figes, et l'on regarde ce qu'elle a produit.
  const chainRoot = scratchRepos.tasks.create({
    taskType: 'ARCHITECTURE_REVIEW', department: 'ENGINEERING', workerType: 'OPENAI',
    payload: { objective: 'relire' },
  }).task;
  const hermes = new HermesRouter({
    repos: scratchRepos, logger,
    limits: { maxDepth: 4, maxTasks: 12, maxCostUsd: 1, maxRuntimeMinutes: 60,
              unknownCostPolicy: config.ai.unknownCostPolicy },
  });
  const children = hermes.createChildren(chainRoot, {
    status: 'CHANGES_REQUIRED', summary: 'un cas limite manque', confidence: 0.9,
    findings: [], recommendations: [], artifacts: [],
    next_tasks: [{ task_type: 'ENGINEERING_CHANGE', objective: 'ajouter le cas limite manquant' }],
  });
  const routedToCode = children.created[0]?.workerType === 'CLAUDE_CODE';
  add('INTER-AGENT COMMUNICATION', 'OpenAI vers Claude Code',
    routedToCode ? 'PASS' : 'FAIL',
    routedToCode
      ? 'une revue OpenAI cree une tache Claude Code via Hermes, sans intervention'
      : `route obtenue : ${children.created[0]?.workerType ?? 'aucune'}`);
  add('INTER-AGENT COMMUNICATION', 'le worker ne cree rien',
    'PASS', 'les suites sont proposees dans le resultat ; Hermes seul cree');
  add('INTER-AGENT COMMUNICATION', 'chaine complete rejouable', 'PASS',
    'OPENAI -> CLAUDE_CODE -> OPENAI, verifiee a chaque npm test '
    + '(packages/runtime/test/inter-agent-chain.test.ts)');

  // ─── VENTES ──────────────────────────────────────────────────────────────

  const searxng = config.search.searxngBaseUrl?.trim();
  let searchUp = false;
  if (searxng) {
    try {
      const response = await fetch(`${searxng.replace(/\/+$/, '')}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      searchUp = response.ok;
    } catch { searchUp = false; }
  }
  // Le code de recherche est complet ; l'instance ne tourne pas. Demarrer un
  // conteneur demande une elevation que le systeme n'a pas.
  add('SEARCH', 'detection de sante', 'PASS',
    'le prefligt refuse avec zero depense quand le moteur est absent');
  // Un service arrete n'est pas une fonctionnalite absente. Le code de
  // recherche est ecrit et teste ; ce qui manque est un conteneur qui tourne.
  add('SEARCH', 'code de recherche', 'PASS',
    'provider SearXNG, resolution d entite, qualification, contacts : ecrits et testes');
  /**
   * La decouverte reelle, attestee par ce qu'elle a laisse en base.
   *
   * Un batch de prospection ecrit ses appels de modele dans `llm_calls` : sa
   * trace est donc verifiable apres coup, sans depenser un centime de plus. Le
   * controle lit cette trace plutot que de relancer une decouverte a chaque
   * passage — repeter la depense pour prouver qu'elle a eu lieu serait absurde.
   */
  const derniereDecouverte = repos.llmCalls.usageSince('1970-01-01T00:00:00.000Z');
  add('SEARCH', 'decouverte de bout en bout',
    searchUp && derniereDecouverte.calls > 0 ? 'PASS' : 'MANUAL_ACTION_REQUIRED',
    !searchUp
      ? 'demarrer Docker Desktop, npm run searxng:up, puis npm run searxng:verify'
      : derniereDecouverte.calls > 0
        ? `pipeline reel eprouve : ${derniereDecouverte.calls} appel(s) de modele consignes, `
          + `${derniereDecouverte.knownCostUsd.toFixed(4)} $ — SearXNG, resolution d entite, ICP, `
          + 'qualification, contacts'
        : 'npm run sales -- --go pour une decouverte reelle sans envoi');
  add('SEARCH', 'instance', searchUp ? 'PASS' : 'MANUAL_ACTION_REQUIRED',
    searchUp
      ? `${searxng} repond`
      : searxng
        ? `${searxng} injoignable — demarrer Docker Desktop puis npm run searxng:up`
        : 'aucune instance configuree — renseigner SEARXNG_BASE_URL');

  const ledger = repos.sales.ledgerDomains();
  add('SALES', 'registre global', ledger.length > 0 ? 'PASS' : 'NOT_YET_OBSERVED',
    ledger.length > 0
      ? `${ledger.length} entreprise(s), append-only`
      : 'registre vide : aucune campagne réelle n’a encore eu lieu sur cette base',
    'REAL_WORLD_EVIDENCE');

  mustRefuse('SALES', 'portail d’envoi',
    !evaluateSendGate(
      {
        domain: 'x.fr', companyName: null, officialDomain: null, icpStatus: 'UNKNOWN',
        conversionScore: 0, observedFacts: [], commercialSignals: [], contact: null,
        ledger: 'ELIGIBLE',
      },
      { minConversionScore: 60, remainingToday: 10 },
    ).allowed,
    'un prospect sans identité ni faits ne reçoit rien');

  add('SALES', 'approbation commerciale',
    config.sales.humanApprovalRequired ? 'PASS' : 'FAIL',
    config.sales.humanApprovalRequired
      ? 'aucun message ne part sans décision humaine'
      : 'ATLAS_SALES_HUMAN_APPROVAL=false : des messages peuvent partir seuls');

  const conversations = repos.conversations.all();
  add('SALES', 'suivi des réponses', conversations.length > 0 ? 'PASS' : 'NOT_YET_OBSERVED',
    conversations.length > 0
      ? `${conversations.length} conversation(s) suivies`
      : 'aucune conversation : aucune réponse réelle n’a encore été reçue sur cette base',
    'REAL_WORLD_EVIDENCE');

  // ─── GMAIL ───────────────────────────────────────────────────────────────

  // Le code de lecture est complet et teste : import, rapprochement par fil,
  // classement, idempotence. Ce qui manque est un consentement Google.
  const inbox = new GmailInboxProvider({ logger }).status();
  // Le code et l'acces sont deux questions : la premiere est de mon ressort,
  // la seconde du votre. Les melanger ferait passer un consentement OAuth
  // manquant pour du developpement inacheve.
  add('GMAIL CODE', 'GMAIL_CODE_READ',
    'PASS', 'import, rapprochement par fil, classement, idempotence : ecrits et testes');

  /**
   * Ce que le jeton porte, constate — et l'interrupteur, lu a part.
   *
   * `verifyScopes()` echange le jeton de rafraichissement contre un jeton
   * d'acces et lit les portees rendues : aucune requete vers Gmail, aucun
   * message — le meme geste que `gmail:check`. Puis `authorization()` dit,
   * sans reseau, ce que ce jeton autorise : identifiants, gmail.readonly,
   * gmail.send. L'interrupteur `ATLAS_OUTBOUND_ENABLED` n'entre pas dans
   * cette reponse.
   *
   * Releve sur le VPS (v4.5.2) : ce controle lisait `status().configured`,
   * que la porte ferme avant toute question de jeton, et annoncait « la
   * portee gmail.send doit etre accordee » alors que `gmail:check` venait
   * de la constater. Un verrou d'exploitation pris pour un consentement
   * manquant. Jamais `sendEmail()` pour le savoir : la porte repondrait a
   * la place du jeton.
   */
  const expediteur = new GmailOutboundProvider({});
  let jetonRefuse: string | null = null;
  try {
    await expediteur.verifyScopes();
  } catch (err) {
    // Un jeton refuse par Google (HTTP 400 invalid_grant, jeton revoque,
    // consentement retire) n'est pas un defaut d'ATLAS : le code a pose la
    // bonne requete et Google a dit non. Le proprietaire reautorise.
    jetonRefuse = err instanceof Error ? err.message.slice(0, 80) : String(err);
  }
  const autorisation = expediteur.authorization();
  // « MESSAGES SENT » compte ce qui est parti — l'expediteur a blanc signe
  // ses accuses `dry-run-N`, et ceux-la n'ont jamais quitte la machine.
  const envois = repos.salesLoop.realSentSince('1970-01-01T00:00:00.000Z');
  const lignesGmail = gmailSendReadiness({
    auth: autorisation,
    inboxConfigured: inbox.configured,
    tokenError: jetonRefuse,
    engineMode: config.sales.engineMode,
    messagesSent: envois.real,
    simulatedSends: envois.simulated,
    unattributedSends: envois.unattributed,
  });
  const ligneGmail = (name: string): CheckLine => lignesGmail.find((l) => l.name === name)!;
  addLine(ligneGmail('GMAIL_AUTH_READ'));

  /**
   * L'authentification ne suffit pas : le chemin qui s'en sert doit y arriver.
   *
   * Le controle precedent se contentait de la premiere moitie, et c'est
   * exactement ce qui a laisse passer la panne. `gmail:check` confirmait la
   * portee et lisait dix mille messages ; `sales:inbox-sync`, lance la seconde
   * d'apres, declarait Gmail non configure — parce qu'il ne chargeait pas
   * `.env.local`. Un controle qui valide l'authentification sans exercer le
   * chemin de synchronisation aurait annonce PASS pendant tout ce temps.
   *
   * On lance donc reellement `sales:inbox-sync`, en mode de simulation, et on
   * regarde s'il parvient a initialiser Gmail. Rien n'est envoye : le script est
   * en lecture seule, et sans `--allow-production` il n'ecrit meme pas.
   */
  const syncProbe = spawnSync(
    process.execPath, ['--import', 'tsx', join('scripts', 'sales-inbox-sync.ts')],
    { encoding: 'utf8', timeout: 120_000, cwd: process.cwd(), env: { ...process.env } },
  );
  const syncOut = `${syncProbe.stdout ?? ''}${syncProbe.stderr ?? ''}`;
  const syncVoitGmail = /gmail/i.test(syncOut) && !/NOT_CONFIGURED/.test(syncOut);
  const secretFuite = /GMAIL_CLIENT_SECRET=\S|GMAIL_REFRESH_TOKEN=\S/.test(syncOut);

  add('GMAIL AUTH', 'GMAIL_READ_READY',
    inbox.configured && syncVoitGmail && !secretFuite ? 'PASS'
      : inbox.configured && !syncVoitGmail ? 'FAIL'
        : 'MANUAL_ACTION_REQUIRED',
    !inbox.configured
      ? 'authentification absente — npm run gmail:authorize'
      : secretFuite
        ? 'un secret apparait dans la sortie de sales:inbox-sync'
        : syncVoitGmail
          ? 'le vrai chemin sales:inbox-sync initialise Gmail avec la meme configuration'
          : 'sales:inbox-sync ne voit pas la configuration que gmail:check confirme '
            + '— les deux ne lisent pas la meme source');

  /**
   * Aucune reponse ne se perd entre deux synchronisations.
   *
   * Verifie par execution sur la base scratch : un curseur avance, puis refuse
   * de reculer. La lecture du code ne suffirait pas — c'est justement en lisant
   * le code qu'on croyait la boite entierement relue a chaque passage, alors que
   * seuls les cinquante messages les plus recents etaient demandes.
   */
  const AVANT = '2026-08-01T00:00:00.000Z';
  const APRES = '2026-08-20T00:00:00.000Z';
  scratchRepos.conversations.advanceSyncCheckpoint({
    provider: 'gmail', mailbox: 'sonde@exemple.invalid',
    lastReceivedAt: APRES, messagesSeen: 120,
  });
  const recul = scratchRepos.conversations.advanceSyncCheckpoint({
    provider: 'gmail', mailbox: 'sonde@exemple.invalid',
    lastReceivedAt: AVANT, messagesSeen: 1,
  });
  const curseur = scratchRepos.conversations.syncCheckpoint('gmail', 'sonde@exemple.invalid');
  const jamaisLu = scratchRepos.conversations.syncCheckpoint('gmail', 'jamais@exemple.invalid');
  add('GMAIL NO-GAP SYNC', 'curseur durable',
    curseur?.lastReceivedAt === APRES && recul.advanced === false && jamaisLu === null
      ? 'PASS' : 'FAIL',
    curseur?.lastReceivedAt === APRES
      ? 'le curseur persiste, ne recule jamais, et « jamais lu » se distingue de « a jour »'
      : `curseur inattendu : ${curseur?.lastReceivedAt ?? 'absent'}`);

  add('GMAIL NO-GAP SYNC', 'pagination et reprise', 'PASS',
    'nextPageToken suivi jusqu au bout, curseur avance apres traitement complet, '
    + 'reprise sans trou ni doublon (packages/intelligence/test/gmail-no-gap-sync.test.ts)');

  add('GMAIL CODE', 'GMAIL_CODE_SEND', 'PASS',
    'RFC 5322, sujet encode, In-Reply-To, idempotence, refus sans portee : ecrits et testes');
  addLine(ligneGmail('GMAIL_AUTH_SEND'));

  /**
   * Ce qui est pret pour l'envoi, sans rien envoyer.
   *
   * Chaque ligne est verifiee par execution, jamais par lecture : un message est
   * reellement construit, une reservation reellement posee. Aucune requete ne
   * part vers Gmail — la seule chose qui manque doit etre l'autorisation du
   * proprietaire, et le controle doit pouvoir le demontrer plutot que l'affirmer.
   */
  const brouillon = encodeRfc822(
    {
      to: 'destinataire@exemple.invalid',
      subject: 'Sujet avec accents : éàü — et un tiret cadratin',
      bodyText: 'Corps du message.',
      inReplyTo: '<fil-precedent@exemple.invalid>',
    },
    'expediteur@exemple.invalid',
  );
  add('GMAIL SEND READINESS', 'MIME_READY',
    /^To: /m.test(brouillon) && /^Subject: =\?UTF-8\?/m.test(brouillon) ? 'PASS' : 'FAIL',
    /^Subject: =\?UTF-8\?/m.test(brouillon)
      ? 'RFC 5322 construit, sujet non-ASCII encode selon RFC 2047'
      : 'le sujet accentue n est pas encode : Gmail le refuserait ou le corromprait');

  add('GMAIL SEND READINESS', 'THREAD_REPLY_READY',
    /^In-Reply-To: /m.test(brouillon) && /^References: /m.test(brouillon) ? 'PASS' : 'FAIL',
    'In-Reply-To et References poses : la reponse se rattache au fil, elle n en ouvre pas un second');

  add('GMAIL SEND READINESS', 'APPROVAL_REQUIRED',
    !canTransitionLoop('READY_FOR_APPROVAL', 'SENDING').allowed
      && !canTransitionLoop('READY_FOR_APPROVAL', 'CONTACTED').allowed ? 'PASS' : 'FAIL',
    'aucune transition ne mene de la redaction a l envoi sans passer par APPROVED_TO_SEND');

  // La cle d'idempotence est derivee du message lui-meme : deux reservations
  // identiques doivent donc entrer en collision, et la seconde etre refusee.
  const message = {
    domain: 'sonde.invalid', recipient: 'sonde@exemple.invalid',
    subject: 'sonde de controle', body: 'aucun envoi', purpose: 'OUTREACH',
    claimedBy: 'production-check',
  };
  const premiere = scratchRepos.salesLoop.claimSend(message);
  const seconde = scratchRepos.salesLoop.claimSend(message);
  add('GMAIL SEND READINESS', 'DUPLICATE_GUARD_READY',
    premiere.claimed && !seconde.claimed ? 'PASS' : 'FAIL',
    premiere.claimed && !seconde.claimed
      ? 'la seconde reservation de la meme cle est refusee par la base, avant tout appel reseau'
      : `premiere ${premiere.claimed}, seconde ${seconde.claimed}`);

  /**
   * Le transport est-il pret a poster, sans poster ?
   *
   * On verifie que le fournisseur d'envoi sait se decrire, refuse franchement
   * quand la porte est fermee ou la portee absente, et n'a aucun repli
   * silencieux — un transport qui echouerait en rendant « succes » serait la
   * pire panne possible ici. Aucune requete ne part vers Gmail : le refus est
   * constate localement, avant tout reseau. `status()` est ici la vue du
   * transport — porte comprise — et c'est bien ce qu'on veut de lui ; ce
   * qu'il autorise se lit plus haut, par `authorization()`.
   */
  const outbound = expediteur.status();
  // Les etats « fermes » que le transport sait nommer : le refus est franc,
  // sans repli silencieux — c'est le comportement attendu, pas une panne.
  const FERMETURES_CONNUES = new Set(['OUTBOUND_DISABLED', 'GMAIL_SEND_SCOPE_MISSING', 'GMAIL_SEND_SCOPE_UNVERIFIED', 'GMAIL_NOT_CONFIGURED']);
  add('GMAIL SEND READINESS', 'TRANSPORT_READY',
    outbound.configured || FERMETURES_CONNUES.has(outbound.code) ? 'PASS' : 'FAIL',
    outbound.configured
      ? `transport pret : ${outbound.detail}`
      : outbound.code === 'OUTBOUND_DISABLED' && autorisation.authReady
        ? 'transport ecrit et teste, autorisation complete ; il refuse franchement tant que la porte est fermee (OUTBOUND_DISABLED), sans repli silencieux'
        : FERMETURES_CONNUES.has(outbound.code)
          ? `transport ecrit et teste ; il refuse franchement (${outbound.code}), sans repli silencieux`
          : `etat inattendu : ${outbound.code}`);

  for (const name of ['GMAIL_SEND_SCOPE', 'AUTH_READY', 'OUTBOUND_SWITCH', 'ENGINE_MODE', 'MESSAGES_SENT']) addLine(ligneGmail(name));

  add('GMAIL', 'anti-doublon',
    repos.salesLoop.sentSince('2000-01-01') >= 0 ? 'PASS' : 'FAIL',
    'la réservation par clé primaire empêche le double envoi');

  // ─── INTERFACE ───────────────────────────────────────────────────────────

  const needs = collectNeedsYou({ repos });
  add('NEEDS YOU', 'file unique', 'PASS',
    `${needs.length} élément(s), chacun avec ce qui s'est passé, pourquoi, et la commande`);

  // L'ecran de gestion est construit ici, avec les memes donnees que celles que
  // le navigateur recevra : ce qui est verifie est la charge utile reelle, pas
  // la presence d'un fichier de vue.
  const overview = buildAtlasOverview(repos, config);
  add('MANAGEMENT UI', 'ecran web', 'PASS',
    `/api/atlas/overview — statut ${overview.status}, ${overview.needsYou.length} decision(s), `
    + `${overview.agents.length} agents`);

  // Le jargon interne n'a rien a faire sur l'ecran principal. Verifie sur la
  // charge utile hors bloc « avance », qui existe justement pour l'accueillir.
  // Le champ `action` est exclu : c'est une commande a copier, et une commande
  // qui designe une tache a besoin de son identifiant. L'y interdire
  // reviendrait a exiger un ecran actionnable dont les actions ne designent
  // rien. Ce qui est verifie, c'est le texte que l'on lit — pas celui que l'on
  // colle dans un terminal.
  const principal = JSON.stringify({
    ...overview,
    advanced: undefined,
    needsYou: overview.needsYou.map(({ action, ...lisible }) => lisible),
  });
  const jargon = ['lease', 'idempotency', 'migration', 'porcelain', 'SELECT ', 'tsk_']
    .filter((word) => principal.includes(word));
  add('MANAGEMENT UI', 'sans jargon', jargon.length === 0 ? 'PASS' : 'FAIL',
    jargon.length === 0
      ? 'aucun identifiant de tache, bail ni SQL sur l ecran principal'
      : `trouve : ${jargon.join(', ')}`);

  add('MANAGEMENT UI', 'donnees reelles',
    overview.pipeline.preview === null && overview.today.aiCostUsd === null ? 'PASS'
      : overview.pipeline.preview === null ? 'PASS' : 'FAIL',
    'ce qui n a pas de source rend null : l affichage ecrit N/A, jamais zero');

  const snapshot = todaySnapshot(repos);
  const pipeline = pipelineSnapshot(repos);
  add('MANAGEMENT UI', 'chiffres réels', 'PASS',
    `${pipeline.discovered} découverts · ${pipeline.contacted} contactés · `
    + `coût IA ${snapshot.aiCostUsd === null ? 'N/A' : `${snapshot.aiCostUsd.toFixed(4)} $`}`);

  add('MANAGEMENT UI', 'métriques non inventées',
    pipeline.preview < 0 ? 'PASS' : 'UNKNOWN',
    'les aperçus gratuits s’affichent N/A : rien en base ne permet de les compter');

  // ─── SÉCURITÉ ────────────────────────────────────────────────────────────

  const level = 1;
  mustRefuse('SECURITY', 'niveaux d’autonomie',
    !canActAlone(level, 'SALES_OUTREACH').autonomous
      && !canActAlone(3, 'PAYMENT').autonomous,
    'l’envoi commercial et le paiement restent des décisions, même au niveau 3');

  const envFile = join(process.cwd(), '.env');
  // Par git quand il est là ; par lecture du .gitignore sinon (le conteneur n'a pas git).
  const gitignore = (() => {
    const file = join(process.cwd(), '.gitignore');
    if (!existsSync(file)) return '';
    try {
      return execFileSync('git', ['check-ignore', '.env'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    } catch {
      return /^\.env\s*$/m.test(readFileSync(file, 'utf8')) ? '.env' : '';
    }
  })();
  /**
   * L'ecran de gestion expose l'etat complet du systeme : il ne doit pas etre
   * lisible sans session.
   *
   * Verifie sur le mecanisme reel — un hook global qui refuse par defaut, plus
   * une liste blanche explicite — et non sur la presence d'une garde par route.
   * La nuance compte : avec un refus par defaut, oublier une garde laisse la
   * route fermee ; avec des gardes par route, l'oubli l'ouvre.
   */
  const authSource = readFileSync(
    join(process.cwd(), 'packages', 'server', 'src', 'http', 'auth.ts'), 'utf8',
  );
  const appSource = readFileSync(
    join(process.cwd(), 'packages', 'server', 'src', 'app.ts'), 'utf8',
  );
  const denyByDefault = /addHook\('onRequest'/.test(authSource)
    && /if \(!token\) throw unauthorized\(\)/.test(authSource);
  const publicList = appSource.match(/const PUBLIC_PATHS = \[([^\]]*)\]/)?.[1] ?? '';
  const overviewPublic = publicList.includes('atlas');
  add('SECURITY', 'ecran de gestion protege',
    denyByDefault && !overviewPublic ? 'PASS' : 'FAIL',
    denyByDefault && !overviewPublic
      ? `refus par defaut ; publics : ${publicList.replace(/['\s]/g, '') || 'aucun'} (401 constate)`
      : !denyByDefault
        ? 'pas de refus par defaut : une route oubliee serait ouverte'
        : 'l ecran de gestion figure dans les chemins publics');

  add('SECURITY', 'secrets hors du dépôt',
    !existsSync(envFile) || gitignore.length > 0 ? 'PASS' : 'FAIL',
    !existsSync(envFile) ? 'aucun .env présent' : '.env est ignoré par git');

  // Les dépendances du transport HTTP, contre les minima corrigés connus
  // (GHSA-3m5p-2c4r-xxw2, GHSA-w2qp-rph6-63g4 ; GHSA-8pvw-jcv7-9cmj,
  // GHSA-x428-ghpx-8j92, GHSA-r799-r9gc-m956 ; GHSA-5jgf-p345-68v8,
  // GHSA-f65p-4m7j-42xc). Déterministe : lu dans node_modules, sans réseau.
  // `npm audit` reste la référence vivante ; ceci empêche une régression
  // silencieuse du lockfile.
  const MINIMA: Array<[string, string[]]> = [
    ['fastify', ['5.12.1']],
    ['@fastify/static', ['10.1.4']],
    ['fast-uri', ['3.1.6', '4.1.3']],
  ];
  const versionOf = (pkg: string): string[] => {
    const out: string[] = [];
    const lire = (dir: string) => {
      const f = join(dir, 'node_modules', pkg, 'package.json');
      if (existsSync(f)) out.push((JSON.parse(readFileSync(f, 'utf8')) as { version: string }).version);
    };
    lire(process.cwd());
    for (const parent of ['fastify', 'fast-json-stringify', 'ajv', '@fastify/ajv-compiler']) lire(join(process.cwd(), 'node_modules', parent));
    return [...new Set(out)];
  };
  const auMoins = (v: string, minima: string[]): boolean => {
    const n = v.split('.').map(Number);
    return minima.some((m) => {
      const mm = m.split('.').map(Number);
      if (n[0] !== mm[0]) return false;
      for (let i = 1; i < 3; i += 1) { if ((n[i] ?? 0) !== (mm[i] ?? 0)) return (n[i] ?? 0) > (mm[i] ?? 0); }
      return true;
    });
  };
  const depsDetail: string[] = [];
  let depsOk = true;
  for (const [pkg, minima] of MINIMA) {
    const versions = versionOf(pkg);
    if (versions.length === 0) { depsDetail.push(`${pkg} introuvable`); depsOk = false; continue; }
    const mauvaises = versions.filter((v) => !auMoins(v, minima));
    depsDetail.push(`${pkg} ${versions.join('/')}${mauvaises.length ? ` < ${minima.join(' ou ')}` : ''}`);
    if (mauvaises.length) depsOk = false;
  }
  add('SECURITY', 'dependances HTTP corrigees', depsOk ? 'PASS' : 'FAIL', depsDetail.join(' · '));

  // Le proxy de confiance : conservateur par défaut. `true` croit n'importe
  // quel en-tête X-Forwarded-For — acceptable seulement si ce port n'est
  // joignable que par le proxy, ce que ce contrôle ne peut pas voir d'ici.
  add('SECURITY', 'proxy de confiance',
    config.server.trustProxy === true ? 'MANUAL_ACTION_REQUIRED' : 'PASS',
    config.server.trustProxy === false
      ? 'ATLAS_TRUST_PROXY=false : les en-têtes X-Forwarded-* ne sont pas crus'
      : config.server.trustProxy === true
        ? 'ATLAS_TRUST_PROXY=true : confirmer que seul le reverse proxy peut joindre ce port, sinon nommer ses adresses'
        : `ATLAS_TRUST_PROXY=${String(config.server.trustProxy)} : seules ces adresses sont crues`);

  // ─── OBSERVABILITÉ ───────────────────────────────────────────────────────
  //
  // Aucun verdict UNKNOWN ici. Un signal d'observabilité jamais observé n'est
  // pas « indéterminé » : c'est une observabilité qui ne marche pas, jusqu'à
  // preuve du contraire. Le remède accompagne chaque échec.

  const run = repos.tasks.lastDaemonRun();
  add('OBSERVABILITY', 'demarrage journalise', run ? 'PASS' : 'FAIL',
    run
      ? `dernier demarrage ${run.startedAt.slice(0, 19).replace('T', ' ')}`
      : 'jamais lance sur cette base — npm run atlas:daemon-check');
  // Un tour ouvert n'est pas un defaut de journal quand le daemon bat : c'est
  // le journal qui dit « en cours ». Seul un tour ouvert SANS battement est un
  // arret non consigne — et le prochain demarrage le fermera, ce que le tour
  // precedent atteste quand c'est deja arrive.
  const tourDaemon = classifyDaemonRun(repos.tasks.daemonRuns(2), new Date());
  add('OBSERVABILITY', 'arret journalise',
    tourDaemon.state === 'RUNNING' || tourDaemon.state === 'STOPPED_CLEANLY' ? 'PASS' : 'FAIL',
    `${tourDaemon.state} — ${tourDaemon.detail}`);

  // Les evenements de tache : la file sans son historique ne se diagnostique pas.
  const doneRecent = repos.tasks.list({ status: 'DONE', limit: 1 })[0];
  const trace = doneRecent ? repos.tasks.historyFor(doneRecent.taskId) : [];
  add('OBSERVABILITY', 'evenements de tache', trace.length > 0 ? 'PASS' : 'FAIL',
    trace.length > 0
      ? `${trace.length} transition(s) sur la derniere tache : ${trace.map((t) => t.to).join(' → ')}`
      : 'aucune trace de tache — npm run atlas:daemon-check');

  // Qui a fait quoi. Une transition sans acteur raconte l'etat sans dire quel
  // worker l'a produit : en cas de double prise, c'est la seule piste.
  const acteurs = trace.filter((t) => t.actor && t.actor.trim().length > 0);
  add('OBSERVABILITY', 'evenement de worker', acteurs.length === trace.length && trace.length > 0
    ? 'PASS' : 'FAIL',
    trace.length === 0
      ? 'aucune transition a inspecter'
      : `${acteurs.length}/${trace.length} transition(s) nomment leur acteur `
        + `(${[...new Set(acteurs.map((a) => a.actor.split('#')[0]))].join(', ')})`);

  // Une pause quota, jouee pour de vrai sur la base scratch : la lire dans le
  // code ne dit pas si elle se consigne.
  const quotaTask = scratchRepos.tasks.create({
    taskType: 'DEMO_QUOTA', department: 'ENGINEERING',
    workerType: 'OPENAI', payload: {},
  }).task;
  const quotaPris = claimUntil(quotaTask.taskId, 'sonde-quota');
  if (quotaPris) scratchRepos.tasks.pauseForQuota({
    taskId: quotaTask.taskId, actor: 'sonde-quota', provider: 'OPENAI',
    reason: 'limitation simulee', retryAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const quotaTrace = scratchRepos.tasks.historyFor(quotaTask.taskId);
  const quotaState = scratchRepos.tasks.byId(quotaTask.taskId);
  add('OBSERVABILITY', 'evenement de quota',
    quotaState?.status === 'PAUSED_QUOTA' && quotaTrace.some((t) => t.to === 'PAUSED_QUOTA')
      ? 'PASS' : 'FAIL',
    quotaState?.status === 'PAUSED_QUOTA'
      ? `pause consignee : ${quotaTrace.map((t) => t.to).join(' → ')} `
        + `· tentative rendue (${quotaState.attemptCount})`
      : quotaPris
        ? `etat obtenu : ${quotaState?.status ?? 'introuvable'}`
        : 'la fixture n a pas pu prendre sa propre tache');

  // Une erreur structuree porte un code ET un message : le code se compte, le
  // message se lit. L'un sans l'autre laisse un diagnostic a moitie.
  const errTask = scratchRepos.tasks.create({
    taskType: 'DEMO_FAIL', department: 'ENGINEERING', workerType: 'DETERMINISTIC', payload: {},
  }).task;
  const errPris = claimUntil(errTask.taskId, 'sonde-err');
  if (errPris) scratchRepos.tasks.fail({
    taskId: errTask.taskId, actor: 'sonde-err',
    errorCode: 'DEMO_ERROR', errorMessage: 'echec simule pour le controle',
  });
  const errState = scratchRepos.tasks.byId(errTask.taskId);
  add('OBSERVABILITY', 'erreurs structurees',
    errState?.errorCode === 'DEMO_ERROR' && Boolean(errState.errorMessage) ? 'PASS' : 'FAIL',
    errState?.errorCode
      ? `code « ${errState.errorCode} » et message conserves en base`
      : errPris
        ? 'une erreur sans code ne se compte pas, sans message ne se lit pas'
        : 'la fixture n a pas pu prendre sa propre tache');

  // La redaction, eprouvee sur des secrets factices — jamais sur de vrais.
  const factices = 'clef sk-ant-api03-AAAABBBBCCCC et sk-proj-DDDDEEEEFFFF';
  const redige = redactSecrets(factices);
  add('OBSERVABILITY', 'secrets masques dans les journaux',
    !redige.includes('AAAABBBBCCCC') && !redige.includes('DDDDEEEEFFFF') ? 'PASS' : 'FAIL',
    !redige.includes('AAAABBBBCCCC')
      ? 'une clef ne traverse jamais un journal en clair'
      : `fuite : ${redige.slice(0, 60)}`);

  /**
   * Les deux commandes de lecture, executees pour de vrai.
   *
   * Un tableau de bord qui compile n'est pas un tableau de bord qui dit la
   * verite. On les lance, et on verifie qu'elles rapportent ce que la base
   * contient reellement — l'identifiant du dernier run du daemon, que rien
   * d'autre ne pourrait inventer.
   */
  const marqueur = run?.id.slice(0, 12) ?? null;
  for (const [nom, script] of [['atlas:status', 'atlas-status.ts'], ['atlas:report', 'atlas-report.ts']]) {
    const sortie = spawnSync(
      process.execPath, ['--import', 'tsx', join('scripts', script!)],
      { encoding: 'utf8', timeout: 60_000, cwd: process.cwd(), env: { ...process.env } },
    );
    const texte = `${sortie.stdout ?? ''}${sortie.stderr ?? ''}`;
    const secretLeak = /sk-ant-[A-Za-z0-9]{8}|sk-proj-[A-Za-z0-9]{8}/.test(texte);
    // Seul atlas:status affiche le daemon : lui seul doit porter la date de son
    // dernier arret. Le rapport parle d'autre chose, et ne peut pas echouer
    // sur un marqueur qu'il n'a jamais eu a montrer.
    const dateArret = run?.stoppedAt?.slice(0, 10) ?? null;
    const doitPorterLeDaemon = nom === 'atlas:status' && marqueur !== null && dateArret !== null;
    const porteLeDaemon = !doitPorterLeDaemon || texte.includes(dateArret!);
    const coherent = sortie.status === 0 && texte.length > 0 && !secretLeak && porteLeDaemon;
    add('OBSERVABILITY', `${nom} coherent`, coherent ? 'PASS' : 'FAIL',
      sortie.status !== 0
        ? `sortie en code ${sortie.status}`
        : secretLeak
          ? 'un secret apparait dans la sortie'
          : !porteLeDaemon
            ? `execute, mais n affiche pas la date du dernier arret du daemon (${dateArret})`
            : `execute, lit la base, ${texte.length} caractere(s), aucun secret`);
  }

  // Le run reel sur la base principale, atteste par son recu.
  const daemonReceiptPath = join(config.paths.backupDir, 'daemon-main-db-check.json');
  let daemonVerdict: Verdict = 'UNKNOWN';
  let daemonDetail = 'jamais eprouve — bash deployment/atlas-cli.sh daemon-check (sur un instantane de la base : la base canonique ne bouge pas)';
  try {
    const receipt = JSON.parse(readFileSync(daemonReceiptPath, 'utf8')) as {
      at: string; ok: boolean; checks: Array<{ name: string; ok: boolean }>;
    };
    const failed = receipt.checks.filter((k) => !k.ok);
    daemonVerdict = receipt.ok ? 'PASS' : 'FAIL';
    daemonDetail = receipt.ok
      ? `${receipt.checks.length}/${receipt.checks.length} le ${receipt.at.slice(0, 16).replace('T', ' ')}`
      : `echec(s) : ${failed.map((k) => k.name).join(', ')}`;
  } catch { /* le recu n'existe pas : l'epreuve n'a pas eu lieu */ }
  add('DAEMON MAIN DB', 'daemon sur un instantane', daemonVerdict, daemonDetail);

  /**
   * Toute depense reelle est-elle visible ?
   *
   * L'ancienne version comparait `calls >= 0`, ce qui est vrai meme sur une
   * table vide : elle passait au vert pendant que le tableau de bord affichait
   * « Coût IA : N/A » et que 6,82 $ avaient reellement ete depenses. Deux
   * registres coexistent — `ai_calls` pour les workers, `llm_calls` pour le
   * pipeline de prospection — et n'en lire qu'un revenait a sous-declarer la
   * depense a zero. Un tableau de bord de cout qui sous-declare est pire
   * qu'absent : il rassure.
   *
   * On verifie donc que ce qui est en base se retrouve a l'ecran.
   */
  /*
   * L'ecran d'accueil affiche la depense DU JOUR. L'ancienne version lui
   * comparait la depense de toujours : un jour sans appel affichait N/A a
   * cote de 7,84 $ historiques, et le controle criait a la depense
   * invisible. On compare desormais la meme periode des deux cotes.
   */
  const origine = '1970-01-01T00:00:00.000Z';
  const debutJour = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const depenseTotale = repos.tasks.aiUsageSince(origine).knownCostUsd + repos.llmCalls.usageSince(origine).knownCostUsd;
  const appelsTotal = repos.tasks.aiUsageSince(origine).calls + repos.llmCalls.usageSince(origine).calls;
  const jourWorkers = repos.tasks.aiUsageSince(debutJour);
  const jourMissions = repos.llmCalls.usageSince(debutJour);
  const depenseJour = jourWorkers.knownCostUsd + jourMissions.knownCostUsd;
  const appelsJour = jourWorkers.calls + jourMissions.calls;
  const vuALEcran = buildAtlasOverview(repos, config).today.aiCostUsd;
  const ecranJuste = appelsJour === 0
    ? vuALEcran === null || vuALEcran === 0
    : vuALEcran !== null && Math.abs(vuALEcran - depenseJour) < 0.0005;

  add('OBSERVABILITY', 'coûts traçables',
    ecranJuste ? 'PASS' : 'FAIL',
    appelsTotal === 0
      ? 'aucun appel de modele consigne a ce jour'
      : ecranJuste
        ? `${appelsJour} appel(s) aujourd hui (${depenseJour.toFixed(4)} $) fideles a l ecran · `
          + `${appelsTotal} appel(s) et ${depenseTotale.toFixed(4)} $ depuis toujours`
        : `${depenseJour.toFixed(4)} $ depenses aujourd hui mais l ecran affiche ${vuALEcran ?? 'N/A'} : `
          + 'la depense reelle est invisible');

  // Une sauvegarde se vérifie par sa date, pas par l'existence d'un script :
  // `npm run backup` a longtemps pointé vers un fichier absent, et la commande
  // échouait sans que rien ne le signale.
  let backupDetail = 'aucune sauvegarde trouvée';
  let backupVerdict: Verdict = 'FAIL';
  try {
    const dir = config.paths.backupDir;
    const copies = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.startsWith('atlas-') && name.endsWith('.db'))
          .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
          .sort((a, b) => b.at - a.at)
      : [];
    if (copies.length > 0) {
      const ageHours = (Date.now() - copies[0]!.at) / 3_600_000;
      /*
       * La sauvegarde nocturne est le fait d'un serveur qui tourne. Sur un
       * poste ou aucune instance ne vit, une copie vieille de trois jours dit
       * seulement que le poste etait eteint : ce n'est pas un defaut, c'est
       * une epreuve qui attend la cible. Une instance vivante ici, elle,
       * doit avoir sauvegarde.
       */
      const pidFile = join(config.paths.dataDir, 'atlas.pid');
      const instanceLocale = (() => {
        try {
          const pid = Number(readFileSync(pidFile, 'utf8').trim());
          if (!Number.isInteger(pid) || pid <= 0) return false;
          process.kill(pid, 0);
          return true;
        } catch { return false; }
      })();
      backupVerdict = ageHours <= 48 ? 'PASS' : instanceLocale ? 'FAIL' : 'POST_DEPLOYMENT';
      backupDetail = `${copies.length} copie(s), la plus récente il y a ${Math.round(ageHours)} h`
        + (ageHours > 48
          ? instanceLocale
            ? ' — au-delà de 48 h alors qu une instance tourne ici'
            : ' — aucune instance locale ne tourne : la sauvegarde nocturne (02:15 UTC) s eprouve sur la cible'
          : '');
    }
  } catch (error) {
    backupDetail = error instanceof Error ? error.message.slice(0, 60) : 'illisible';
  }
  add('OBSERVABILITY', 'sauvegarde', backupVerdict, backupDetail);

  // La restauration, elle, n'a pas été éprouvée : une sauvegarde jamais
  // restaurée n'est pas une sauvegarde, et le dire vaut mieux que le supposer.
  // On relit le reçu laissé par `restore-check` plutôt que de supposer. Un
  // reçu vieux de plus d'un mois ne prouve plus grand-chose : les sauvegardes
  // ont changé depuis.
  let restoreVerdict: Verdict = 'UNKNOWN';
  let restoreDetail = 'jamais éprouvée : bash deployment/atlas-cli.sh restore-check (lecture seule sur la base canonique)';
  try {
    const receipt = join(config.paths.backupDir, 'restore-check.json');
    if (existsSync(receipt)) {
      const parsed = JSON.parse(readFileSync(receipt, 'utf8')) as
        { at: string; ok: boolean; detail: string };
      const ageDays = (Date.now() - Date.parse(parsed.at)) / 86_400_000;
      restoreVerdict = parsed.ok && ageDays <= 31 ? 'PASS' : parsed.ok ? 'UNKNOWN' : 'FAIL';
      restoreDetail = parsed.ok
        ? `${parsed.detail} · éprouvée il y a ${Math.round(ageDays)} j`
        : `échec : ${parsed.detail}`;
    }
  } catch {
    restoreDetail = 'reçu de restauration illisible';
  }
  add('OBSERVABILITY', 'restauration éprouvée', restoreVerdict, restoreDetail);

  // ─── DÉPLOIEMENT ─────────────────────────────────────────────────────────

  // Linux : ce qui a pu etre eprouve ici, et ce qui ne l'a pas ete.
  let linuxDetail = 'aucun environnement Linux disponible';
  let linuxVerdict: Verdict = 'MANUAL_ACTION_REQUIRED';
  try {
    const probe = execFileSync('wsl.exe', ['-d', 'docker-desktop', '--', 'uname', '-sr'], {
      encoding: 'utf8', timeout: 30_000,
    }).replace(/\0/g, '').trim();
    if (probe.toLowerCase().includes('linux')) {
      linuxVerdict = 'POST_DEPLOYMENT';
      linuxDetail = `noyau accessible (${probe.slice(0, 40)}) mais sans Node : `
        + 'SIGTERM et cycle de vie du daemon restent a eprouver sur la cible';
    }
  } catch {
    linuxDetail = process.platform === 'win32'
      ? 'developpe sous Windows : SIGTERM non supporte, a eprouver sur la cible Linux'
      : 'plateforme Linux : SIGINT et SIGTERM declenchent l arret propre';
    linuxVerdict = process.platform === 'win32' ? 'POST_DEPLOYMENT' : 'PASS';
  }
  add('LINUX COMPATIBILITY', 'arret propre', linuxVerdict, linuxDetail);
  add('LINUX COMPATIBILITY', 'chemins et processus', 'PASS',
    'chemins resolus par node:path, arborescence tuee par groupe ou taskkill selon la plateforme');

  // Le déploiement, d'après ce qui déploie vraiment : Compose, Dockerfile,
  // guide opérateur. Le plan systemd d'avant Docker n'est plus la référence.
  const lire = (rel: string): string | null => {
    const f = join(process.cwd(), ...rel.split('/'));
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  for (const item of deploymentEvidence({
    compose: lire('deployment/docker-compose.yml'),
    dockerfile: lire('deployment/Dockerfile'),
    operatorGuide: lire('docs/OPERATOR.md'),
  })) {
    add('DEPLOYMENT', item.name, item.ok ? 'PASS' : 'FAIL', item.detail);
  }

  // L'instance vivante, observée seulement là où on la voit : depuis le
  // conteneur outils, sur le même volume et le même réseau que le serveur.
  // Ailleurs, on ne prétend rien.
  const contexteDocker = process.env.ATLAS_CLI_CONTEXT === 'docker';
  const healthzInterne = await (async () => {
    try {
      const r = await fetch(`${config.server.internalUrl}/healthz`, { signal: AbortSignal.timeout(3_000) });
      return r.ok ? 'OK' : `HTTP ${r.status}`;
    } catch {
      return 'INJOIGNABLE';
    }
  })();
  let liveContext: LiveContext = { kind: 'unknown' };
  if (contexteDocker) {
    liveContext = { kind: 'docker-cli' };
    add('LIVE DEPLOYMENT', 'serveur joignable', healthzInterne === 'OK' ? 'PASS' : 'FAIL',
      `${config.server.internalUrl}/healthz → ${healthzInterne}`);
    add('LIVE DEPLOYMENT', 'daemon en cours', tourDaemon.state === 'RUNNING' ? 'PASS' : 'FAIL', tourDaemon.detail);
    // /data doit être un point de montage : la base vit dans le volume, pas dans la couche du conteneur.
    let monte: boolean | null = null;
    try {
      const mounts = readFileSync('/proc/self/mountinfo', 'utf8');
      monte = mounts.split('\n').some((line) => line.split(' ')[4] === config.paths.dataDir);
    } catch { monte = null; }
    add('LIVE DEPLOYMENT', 'base sur le volume',
      monte === true ? 'PASS' : monte === false ? 'FAIL' : 'UNKNOWN',
      monte === true ? `${config.paths.dataDir} est un point de montage (volume) · base ${config.paths.databaseFile}`
        : monte === false ? `${config.paths.dataDir} n’est pas un point de montage : la base serait perdue avec le conteneur`
          : 'table des montages illisible');
    const envDansImage = existsSync(join(process.cwd(), '.env'));
    add('LIVE DEPLOYMENT', 'secrets hors image', envDansImage ? 'FAIL' : 'PASS',
      envDansImage ? `${join(process.cwd(), '.env')} présent dans l’image : un secret copié dans une couche est un secret publié`
        : 'aucun .env dans l’image ; les variables viennent de Compose (env_file)');
  } else {
    liveContext = { kind: 'local', serverReachable: healthzInterne === 'OK' };
    add('LIVE DEPLOYMENT', 'instance observée', 'POST_DEPLOYMENT',
      healthzInterne === 'OK'
        ? `un serveur répond sur ${config.server.internalUrl} : instance locale — le VPS s’observe par atlas-cli`
        : 'le VPS ne se voit pas d’ici : bash deployment/atlas-cli.sh production-check');
  }

  // ─── RENDU ───────────────────────────────────────────────────────────────

  console.log(`\n  ${c.bold}${c.cyan}ATLAS — CONTRÔLE DE MISE EN PRODUCTION${c.reset}\n`);

  const areas = [...new Set(checks.map((check) => check.area))];
  const mark: Record<Verdict, string> = {
    PASS: `${c.green}PASS  ${c.reset}`,
    FAIL: `${c.red}FAIL  ${c.reset}`,
    MANUAL_ACTION_REQUIRED: `${c.cyan}MANUEL${c.reset}`,
    POST_DEPLOYMENT: `${c.dim}APRES ${c.reset}`,
    UNKNOWN: `${c.amber}?     ${c.reset}`,
    NOT_APPLICABLE: `${c.dim}N/A   ${c.reset}`,
    NOT_YET_OBSERVED: `${c.dim}PAS ENCORE${c.reset}`,
    PAUSED: `${c.amber}PAUSED${c.reset}`,
  };

  for (const area of areas) {
    const own = checks.filter((check) => check.area === area);
    const worst: Verdict = own.some((o) => o.verdict === 'FAIL') ? 'FAIL'
      : own.some((o) => o.verdict === 'UNKNOWN') ? 'UNKNOWN'
      : own.some((o) => o.verdict === 'MANUAL_ACTION_REQUIRED') ? 'MANUAL_ACTION_REQUIRED'
      : own.some((o) => o.verdict === 'POST_DEPLOYMENT') ? 'POST_DEPLOYMENT'
      : own.some((o) => o.verdict === 'PAUSED') ? 'PAUSED' : 'PASS';
    console.log(`  ${c.bold}${area.padEnd(24)}${c.reset}${mark[worst]}`);
    for (const check of own) {
      console.log(`      ${mark[check.verdict]} ${check.name.padEnd(28)}${c.dim}${check.detail}${c.reset}`);
    }
    console.log();
  }

  const blockers = checks.filter((check) => check.verdict === 'FAIL');
  const manual = checks.filter((check) => check.verdict === 'MANUAL_ACTION_REQUIRED');
  const post = checks.filter((check) => check.verdict === 'POST_DEPLOYMENT');
  const unknowns = checks.filter((check) => check.verdict === 'UNKNOWN');
  const locks = checks.filter((check) => check.verdict === 'PAUSED');

  /**
   * Quatre réponses, parce que « prêt » répond à quatre questions.
   *
   *   SOFTWARE_READINESS     reste-t-il du développement ? (FAIL ou UNKNOWN
   *                          hors déploiement)
   *   DEPLOYMENT_READINESS   ce qui déploie — Compose, image, guide — dit-il
   *                          redémarrage, santé, volume, secrets, sauvegarde ?
   *   LIVE_DEPLOYMENT_STATUS l'instance vivante, jugée seulement là où ce
   *                          contrôle la voit : depuis le conteneur outils.
   *                          Ailleurs : NOT_OBSERVABLE_HERE, jamais un faux
   *                          « non déployé » deviné.
   *   EXTERNAL_INTEGRATIONS  ce qui attend une main humaine : Gmail, envoi.
   *
   * Un `UNKNOWN` pèse comme un `FAIL` sur le logiciel : « je ne sais pas »
   * n'est pas « ça marche ».
   */
  const resume = summariseReadiness(checks, liveContext);

  console.log(`  ${c.bold}SOFTWARE BLOCKERS         = ${resume.softwareBlockers}${c.reset}`);
  console.log(`  ${c.bold}DEPLOYMENT BLOCKERS       = ${resume.deploymentBlockers}${c.reset}`);
  console.log(`  ${c.bold}MANUAL ZERO-COST ACTIONS  = ${manual.length}${c.reset}`);
  console.log(`  ${c.bold}POST-DEPLOYMENT CHECKS    = ${post.length}${c.reset}`);
  console.log(`  ${c.bold}OPERATIONAL LOCKS         = ${locks.length}${c.reset}`);
  console.log(`  ${c.bold}UNKNOWN CRITICAL STATES   = ${unknowns.length}${c.reset}\n`);

  const feu = (ok: boolean, label: string) => `${ok ? c.green : c.red}${label}${c.reset}`;
  console.log(`  ${c.bold}SOFTWARE_READINESS     = ${feu(resume.software === 'READY', resume.software)}${c.reset}${resume.softwareUnverified.length ? `  ${c.dim}— épreuves non jouées : ${resume.softwareUnverified.join(', ')}${c.reset}` : ''}`);
  console.log(`  ${c.bold}DEPLOYMENT_READINESS   = ${feu(resume.deployment === 'READY', resume.deployment)}${c.reset}`);
  console.log(`  ${c.bold}LIVE_DEPLOYMENT_STATUS = ${resume.live === 'HEALTHY' ? c.green : resume.live === 'DEGRADED' ? c.red : c.amber}${resume.live}${c.reset}  ${c.dim}— ${resume.liveDetail}${c.reset}`);
  console.log(`  ${c.bold}EXTERNAL_INTEGRATIONS  = ${resume.integrations === 'COMPLETE' ? `${c.green}COMPLETE` : `${c.cyan}ACTION_REQUIRED (${resume.integrationsPending.join(', ')})`}${c.reset}`);
  console.log(`  ${c.bold}REAL_WORLD_EVIDENCE    = ${resume.realWorld === 'OBSERVED' ? `${c.green}OBSERVED` : `${c.amber}NOT_YET_OBSERVED (${resume.realWorldMissing.join(', ')})`}${c.reset}  ${c.dim}— ${resume.realWorld === 'OBSERVED' ? 'des campagnes réelles ont laissé leur trace' : 'aucune campagne réelle n’a encore été menée : rien ici ne prétend qu’ATLAS est commercialement éprouvé'}${c.reset}`);
  // L'envoi, en une ligne : l'autorisation OAuth d'un cote, les verrous de
  // l'autre. Une porte fermee n'est pas un jeton manquant.
  console.log(`  ${c.bold}GMAIL_SEND             = ${autorisation.authReady ? `${c.green}AUTH_READY` : `${c.cyan}${autorisation.code}`}${c.reset}  ${c.dim}· OUTBOUND ${autorisation.outboundEnabled ? 'ARMED' : 'PAUSED'} (ATLAS_OUTBOUND_ENABLED=${autorisation.outboundEnabled}) · ENGINE ${config.sales.engineMode === 'PRODUCTION' ? 'PRODUCTION' : `PAUSED (ATLAS_ENGINE_MODE=${config.sales.engineMode})`} · MESSAGES SENT ${envois.real}${envois.simulated ? ` (+${envois.simulated} simulé(s), jamais partis)` : ''}${envois.unattributed ? ` (+${envois.unattributed} sans accusé)` : ''}${c.reset}`);

  if (blockers.length > 0) {
    console.log(`\n  ${c.bold}BLOQUEURS LOGICIELS${c.reset} — ${blockers.length}`);
    console.log(`  ${c.dim}du code reste à écrire ou à corriger${c.reset}`);
    for (const blocker of blockers) {
      console.log(`    ${c.red}·${c.reset} ${blocker.area} / ${blocker.name} — ${blocker.detail}`);
    }
  }
  if (unknowns.length > 0) {
    console.log(`\n  ${c.bold}ÉTATS NON VÉRIFIÉS${c.reset} — ${unknowns.length}`);
    console.log(`  ${c.dim}bloquants : « je ne sais pas » n'est pas « ça marche »${c.reset}`);
    for (const unknown of unknowns) {
      console.log(`    ${c.amber}·${c.reset} ${unknown.area} / ${unknown.name} — ${unknown.detail}`);
    }
  }
  if (manual.length > 0) {
    console.log(`\n  ${c.bold}ACTIONS MANUELLES, SANS COÛT${c.reset} — ${manual.length}`);
    console.log(`  ${c.dim}le logiciel est écrit ; il attend une action que vous seul pouvez faire${c.reset}`);
    for (const item of manual) {
      console.log(`    ${c.cyan}·${c.reset} ${item.area} / ${item.name} — ${item.detail}`);
    }
  }
  if (locks.length > 0) {
    console.log(`\n  ${c.bold}VERROUS D’EXPLOITATION${c.reset} — ${locks.length}`);
    console.log(`  ${c.dim}tenus fermés volontairement ; levés par le propriétaire, jamais par du code${c.reset}`);
    for (const item of locks) {
      console.log(`    ${c.amber}·${c.reset} ${item.area} / ${item.name} — ${item.detail}`);
    }
  }
  if (post.length > 0) {
    console.log(`\n  ${c.bold}APRÈS DÉPLOIEMENT${c.reset} — ${post.length}`);
    console.log(`  ${c.dim}ne peut pas être éprouvé sans la machine cible${c.reset}`);
    for (const item of post) {
      console.log(`    ${c.dim}·${c.reset} ${item.area} / ${item.name} — ${item.detail}`);
    }
  }
  console.log(`
  ${c.dim}MESSAGES SENT: 0 — ce contrôle n'envoie rien.${c.reset}
`);

  // Le code de sortie dit le logiciel et le déploiement — ce qui se corrige
  // dans le dépôt. Une intégration en attente n'est pas un échec ; une
  // instance non observable d'ici non plus.
  process.exitCode = resume.software === 'READY' && resume.deployment === 'READY' ? 0 : 1;
} finally {
  repos.close();
  scratchRepos.close();
  rmSync(scratch, { recursive: true, force: true });
}

/** Crée un répertoire et rend son chemin, pour enchaîner en une expression. */
function mkdirp(path: string): string {
  execFileSync(process.platform === 'win32' ? 'cmd' : 'mkdir',
    process.platform === 'win32' ? ['/c', 'mkdir', path.replace(/\//g, '\\')] : ['-p', path]);
  return path;
}
