/**
 * Applique les corrections d'identité et de doublons aux données déjà écrites.
 *
 *   node scripts/repair-registry.mjs           constate, ne modifie rien
 *   node scripts/repair-registry.mjs --apply   corrige
 *
 * Les corrections posées dans le code protègent les écritures futures. Elles
 * ne défont pas ce qui est déjà en base — et REVENUE-001 y a laissé une fiche
 * dont le nom et le domaine désignent deux entreprises différentes, plus une
 * quinzaine de contacts dupliqués.
 *
 * Rien n'est supprimé. Une fiche contradictoire passe en `conflict`, ce qui
 * l'écarte des livrables sans effacer la trace du défaut : c'est précisément
 * cette trace qui permet de vérifier plus tard que la correction tient.
 */
import Database from 'better-sqlite3';

const APPLY = process.argv.includes('--apply');
const db = new Database('data/atlas.db');

const say = (line) => console.log(`  ${line}`);
console.log(`\n  Réparation du registre — ${APPLY ? 'APPLICATION' : 'constat seul'}\n`);

// ── 1. Les identités contradictoires ───────────────────────────────────────
//
// La clé canonique est calculée à la création et jamais recalculée. Une fiche
// dont la clé dit `d:X` et dont le domaine dit `Y` a vu son identité réécrite
// après coup — c'est la signature exacte du défaut.
// Restreint aux fiches de lignée `live` : les fiches simulées présentent la
// même incohérence par construction — leur générateur tire la clé et le
// domaine séparément — et les marquer noierait le signal.
//
// Et surtout, toute dérive n'est pas un conflit. « d:lilie-gmbh.de » contre
// « lilie.de » est la même entreprise sous deux orthographes de domaine ;
// « d:heidelberg.com » contre « bhs-corrugated.com » est le cas interdit —
// une entreprise portant le domaine d'une autre. Seul le second est mis en
// quarantaine : marquer le premier reviendrait à écarter un candidat correct,
// et un drapeau qui se déclenche à tort finit ignoré.
const root = (domain) => (domain ?? '').split('.')[0] ?? '';
const related = (a, b) => {
  const [x, y] = [root(a), root(b)].sort((p, q) => p.length - q.length);
  return x.length >= 4 && y.includes(x);
};

const allDrift = db
  .prepare(
    `SELECT id, canonical_key, name, domain, city, identity_status, data_origin
       FROM companies
      WHERE canonical_key LIKE 'd:%' AND domain IS NOT NULL
        AND canonical_key != 'd:' || domain`,
  )
  .all();

const live = allDrift.filter((r) => r.data_origin === 'live');
const drifted = live.filter((r) => !related(r.canonical_key.slice(2), r.domain));
const benign = live.filter((r) => related(r.canonical_key.slice(2), r.domain));

say(`Identités contradictoires, lignée réelle : ${drifted.length}`);
say(`  ${benign.length} dérive(s) bénigne(s) — même racine de domaine, laissée(s) intacte(s)`);
for (const row of benign) {
  say(`    ${row.name} : « ${row.canonical_key} » ~ « ${row.domain} »`);
}
say(`  ${allDrift.length - live.length} sur des fiches simulées — artefact du générateur, ignorées`);
for (const row of drifted) {
  say(`  ${row.name}`);
  say(`    clé « ${row.canonical_key} » ≠ domaine « ${row.domain} »`);
  if (APPLY && row.identity_status !== 'conflict') {
    db.prepare('UPDATE companies SET identity_status = ?, updated_at = ? WHERE id = ?').run(
      'conflict',
      new Date().toISOString(),
      row.id,
    );
    say(`    → mise en conflit`);
  }
}

// ── 1 bis. Le nom d'une entreprise sur le domaine d'une autre ──────────────
//
// La dérive clé/domaine ne voit qu'une moitié du problème. La fiche que
// REVENUE-001 a réellement livrée portait la clé `d:bhs-corrugated.com` ET le
// domaine `bhs-corrugated.com` — parfaitement cohérentes entre elles — sous le
// nom « Heidelberg Druckmaschinen AG ». Rien ne dérivait ; tout était faux.
//
// Le contrôle porte donc sur le nom face au domaine. Un chevauchement de
// racine suffit à disculper : « Lilie GmbH » / lilie.de, « Hagenauer+Denk KG »
// / hagenauer-denk.de, « SYS TEC electronic AG » / systec-electronic.com. Sans
// aucun mot commun, la fiche décrit deux entreprises à la fois.
//
// Le test est volontairement permissif : beaucoup d'entreprises ont un domaine
// sans rapport avec leur nom, et les mettre toutes en quarantaine viderait le
// registre. Seule l'absence *totale* de recoupement déclenche.
const tokens = (text) =>
  (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 4);

const LEGAL = new Set(['gmbh', 'kg', 'ohg', 'mbh', 'group', 'holding', 'gruppe', 'corp']);

const incoherent = db
  .prepare(
    `SELECT id, name, domain, canonical_key, identity_status
       FROM companies
      WHERE data_origin = 'live' AND domain IS NOT NULL AND identity_status = 'ok'`,
  )
  .all()
  .filter((row) => {
    const nameTokens = tokens(row.name).filter((t) => !LEGAL.has(t));
    const domainTokens = tokens(root(row.domain));
    if (nameTokens.length === 0) return false;

    const overlap = nameTokens.some((n) =>
      domainTokens.some((d) => d.includes(n) || n.includes(d)),
    );
    if (overlap) return false;

    // Les sigles courts, que le seuil de quatre lettres écarte à tort.
    //
    // « BHS Corrugated » sur bhs-world.com est bien la bonne entreprise ; le
    // premier segment du domaine suffit à l'établir. La comparaison se fait
    // ici sur le nom entier, sans filtre de longueur — c'est justement le mot
    // court qui porte le lien. Trois lettres au minimum : en deçà, la
    // coïncidence devient plus probable que la parenté.
    const flatName = (row.name ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    const firstLabel = root(row.domain).split('-')[0] ?? '';
    if (firstLabel.length >= 3 && flatName.includes(firstLabel)) return false;

    return true;
  });

say('');
say(`Noms sans rapport avec leur domaine : ${incoherent.length}`);
for (const row of incoherent) {
  say(`  ${row.name}`);
  say(`    domaine « ${row.domain} » — aucun mot commun avec le nom`);
  if (APPLY) {
    db.prepare('UPDATE companies SET identity_status = ?, updated_at = ? WHERE id = ?').run(
      'conflict',
      new Date().toISOString(),
      row.id,
    );
    say(`    → mise en conflit`);
  }
}

// ── 2. Les contacts dupliqués ──────────────────────────────────────────────
//
// Mêmes signatures que la déduplication à l'écriture : adresse, téléphone,
// profil, puis nom + rôle. Le plus ancien est conservé et complété par les
// canaux que les autres apportaient — dédupliquer ne doit rien perdre.
const normEmail = (v) => (v ?? '').trim().toLowerCase() || null;
const normPhone = (v) => {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
};
const normLinked = (v) =>
  (v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') ||
  null;
const clean = (v) =>
  (v ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const contacts = db
  .prepare('SELECT * FROM contacts ORDER BY company_id, created_at')
  .all();

const byCompany = new Map();
for (const contact of contacts) {
  if (!byCompany.has(contact.company_id)) byCompany.set(contact.company_id, []);
  byCompany.get(contact.company_id).push(contact);
}

let removed = 0;
let completed = 0;
for (const [, list] of byCompany) {
  const kept = [];
  for (const contact of list) {
    const match = kept.find(
      (k) =>
        (normEmail(contact.email) && normEmail(k.email) === normEmail(contact.email)) ||
        (normPhone(contact.phone) && normPhone(k.phone) === normPhone(contact.phone)) ||
        (normLinked(contact.linkedin) && normLinked(k.linkedin) === normLinked(contact.linkedin)) ||
        (clean(contact.name) &&
          `${clean(contact.name)}|${clean(contact.role)}` ===
            `${clean(k.name)}|${clean(k.role)}`),
    );
    if (!match) {
      kept.push(contact);
      continue;
    }
    removed++;
    const merged = {
      email: match.email ?? contact.email,
      phone: match.phone ?? contact.phone,
      linkedin: match.linkedin ?? contact.linkedin,
      role: match.role ?? contact.role,
    };
    const changes =
      merged.email !== match.email ||
      merged.phone !== match.phone ||
      merged.linkedin !== match.linkedin ||
      merged.role !== match.role;
    if (changes) completed++;
    if (APPLY) {
      if (changes) {
        db.prepare(
          'UPDATE contacts SET email = ?, phone = ?, linkedin = ?, role = ? WHERE id = ?',
        ).run(merged.email, merged.phone, merged.linkedin, merged.role, match.id);
        Object.assign(match, merged);
      }
      db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
    }
  }
}

say('');
say(`Contacts : ${contacts.length} enregistrés · ${removed} doublons · ${completed} complétés par fusion`);

// ── 3. Les preuves écrites deux fois mot pour mot ──────────────────────────
const dupEvidence = db
  .prepare(
    `SELECT company_id, field, lower(trim(claim)) AS c, COUNT(*) AS n, MIN(id) AS keep
       FROM evidence GROUP BY company_id, field, lower(trim(claim)) HAVING n > 1`,
  )
  .all();

let evidenceRemoved = 0;
for (const row of dupEvidence) {
  evidenceRemoved += row.n - 1;
  if (APPLY) {
    db.prepare(
      `DELETE FROM evidence
        WHERE company_id = ? AND field = ? AND lower(trim(claim)) = ? AND id != ?`,
    ).run(row.company_id, row.field, row.c, row.keep);
  }
}
say(`Preuves  : ${evidenceRemoved} copies exactes`);

say('');
say(APPLY ? 'Corrections appliquées.' : 'Aucune modification. Relancez avec --apply.');
console.log();
db.close();
