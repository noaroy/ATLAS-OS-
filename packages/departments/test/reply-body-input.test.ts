import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyInbound, detectOptOut, summarise } from '../src/index.ts';

/**
 * Un vrai courriel ne tient pas dans un argument de ligne de commande.
 *
 * Passer le corps en `--body="…"` a echoue en pratique : au-dela d'une
 * centaine de caracteres multi-mots, l'appel se bloquait avant meme que Node
 * demarre. Reproduit avec une sous-commande qui ne lit jamais ce parametre,
 * donc imputable a la couche d'appel — mais la consequence etait la meme : les
 * seules reponses consignables etaient les courtes, c'est-a-dire justement
 * celles que les regles renvoient en revue humaine faute de matiere.
 *
 * Ces tests portent sur la lecture depuis un fichier, et sur le fait qu'un
 * corps realiste — plusieurs paragraphes, accents, ponctuation — traverse les
 * regles sans se degrader.
 */

const REALISTIC = [
  'Bonjour,',
  '',
  'Merci pour votre message, qui a retenu notre attention. Nous travaillons',
  "effectivement avec plusieurs distributeurs en Europe et nous sommes en train",
  "d'elargir notre reseau sur la peninsule iberique.",
  '',
  'Pourriez-vous nous en dire plus sur le format exact de la livraison, et sur',
  'ce que couvre la selection complete par rapport aux trois exemples gratuits ?',
  '',
  'Bien cordialement,',
  'Le service commercial',
].join('\n');

describe('un corps de message lu depuis un fichier', () => {
  test('traverse les regles sans se degrader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-body-'));
    try {
      const path = join(dir, 'reponse.txt');
      writeFileSync(path, REALISTIC, 'utf8');
      const body = readFileSync(path, 'utf8').trim();

      assert.ok(body.length > 300, 'le corps realiste depasse la taille problematique');
      assert.ok(body.includes('\n'), 'les sauts de ligne sont conserves');

      const verdict = classifyInbound({ kind: 'EMAIL_REPLY', subject: 'Re', body });
      assert.equal(verdict.classification, 'REPLIED');
      assert.ok(verdict.confidence >= 0.8);
      assert.equal(detectOptOut({ body }).optedOut, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('le resume tient sur une ligne, sans couper un mot en deux', () => {
    const summary = summarise(REALISTIC);
    assert.ok(summary.length <= 181, `${summary.length} caracteres`);
    assert.ok(!summary.includes('\n'), 'les sauts de ligne sont aplatis');
    assert.ok(summary.endsWith('…'), 'la troncature est visible');
    // Un mot coupe au milieu se reconnait a un fragment avant l'ellipse.
    const lastWord = summary.slice(0, -1).trim().split(' ').at(-1)!;
    assert.ok(REALISTIC.includes(lastWord), `« ${lastWord} » n'est pas un mot du message`);
  });

  test('un corps court reste intact, sans ellipse', () => {
    assert.equal(summarise('Bonjour, merci.'), 'Bonjour, merci.');
  });

  test('un corps absent se dit, il ne se devine pas', () => {
    assert.equal(summarise(null), 'message sans corps lisible');
    assert.equal(summarise('   '), 'message sans corps lisible');
  });

  test('un desabonnement multi-paragraphes est reconnu', () => {
    const body = [
      'Bonjour,',
      '',
      'Merci de ne plus nous contacter a cette adresse.',
      '',
      'Cordialement',
    ].join('\n');
    const verdict = detectOptOut({ body });
    assert.equal(verdict.optedOut, true);
    assert.equal(verdict.marker, 'ne plus nous contacter');
  });
});
