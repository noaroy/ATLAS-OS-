import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitIntoBlocks, cleanedText, pageTitle, resolveSelection, quoteExistsInSource,
  areNearDuplicates, distinctCommercialFacts, hasEnoughCommercialFacts,
  type SourcedEvidence,
} from '../src/evidence-blocks.ts';
import { verifyClaimAgainstSource } from '../src/claim-verification.ts';
import {
  buildBlockCatalogue, resolveSelections,
} from '../src/verbatim-selection.ts';

/**
 * La preuve est désignée, jamais récrite.
 *
 * Six cycles réels ont produit vingt-cinq entreprises, huit au rang PRIORITY,
 * et zéro brouillon. Chaque fait enregistré était une reformulation du modèle :
 * « Asytec propose du sous-traitance industrielle low-cost », introuvable telle
 * quelle sur la page, rejetée à 50 % de recouvrement.
 *
 * Ces tests tiennent le principe qui remplace la recopie : le modèle rend un
 * numéro de bloc, ATLAS relit le texte à ce numéro. Ce qu'un modèle ne peut pas
 * écrire, il ne peut pas l'inventer.
 */

const PAGE = `<html><head><title>Harmony Béton &mdash; Fabricant</title></head><body>
  <h1>Accueil</h1>
  <p>Nous concevons et fabriquons des solutions b&eacute;ton depuis 1998.</p>
  <p>Notre r&#233;seau de distributeurs couvre aujourd'hui douze d&eacute;partements.</p>
  <ul><li>Contact</li><li>Nos produits sont livr&eacute;s sous quarante-huit heures partout en France.</li></ul>
  <script>var x = "Nous concevons et fabriquons du javascript";</script>
</body></html>`;

// ─── LE DÉCOUPAGE ───────────────────────────────────────────────────────────

describe('la page devient des passages numérotés', () => {
  test('les entités HTML sont décodées', () => {
    /*
     * Sans décodage, « r&#233;seau » ne contient pas « réseau » : une citation
     * parfaitement exacte serait déclarée introuvable. Relevé pour de bon sur
     * europe-industrie.fr.
     */
    const texte = cleanedText(PAGE);
    assert.match(texte, /réseau de distributeurs/);
    assert.match(texte, /béton/);
    assert.doesNotMatch(texte, /&eacute;|&#233;|&mdash;/);
  });

  test('le script et le style ne deviennent jamais des preuves', () => {
    const blocs = splitIntoBlocks(PAGE);
    assert.equal(blocs.some((b) => /javascript/i.test(b.text)), false);
  });

  test('le mobilier de page trop court est écarté', () => {
    // « Accueil », « Contact » : ils annoncent une preuve et n'en montrent aucune.
    const blocs = splitIntoBlocks(PAGE);
    assert.equal(blocs.some((b) => b.text.trim() === 'Contact'), false);
    assert.equal(blocs.some((b) => b.text.trim() === 'Accueil'), false);
  });

  test('les frontières de bloc séparent vraiment', () => {
    // Sans elles, la fin d'un titre se colle au paragraphe suivant et la
    // citation ne se retrouve plus nulle part.
    const blocs = splitIntoBlocks(PAGE);
    assert.equal(blocs.some((b) => /Accueil\s*Nous concevons/.test(b.text)), false);
  });

  test('les numéros sont contigus et commencent à 1', () => {
    const blocs = splitIntoBlocks(PAGE);
    assert.ok(blocs.length >= 3, `${blocs.length} bloc(s)`);
    assert.deepEqual(blocs.map((b) => b.id), blocs.map((_, i) => i + 1));
  });

  test('un passage répété ne compte qu’une fois', () => {
    const repete = `<p>${'Notre réseau de distributeurs couvre douze départements.'}</p>`.repeat(4);
    const blocs = splitIntoBlocks(`<body>${repete}</body>`);
    assert.equal(blocs.length, 1);
  });

  test('le titre déclaré est lu et décodé', () => {
    assert.equal(pageTitle(PAGE), 'Harmony Béton — Fabricant');
    assert.equal(pageTitle('<body>rien</body>'), null);
  });
});

// ─── LA SÉLECTION ───────────────────────────────────────────────────────────

describe('le modèle désigne, il ne rédige pas la citation', () => {
  const blocs = splitIntoBlocks(PAGE);
  const source = { url: 'https://harmony-beton.com/', title: pageTitle(PAGE) };

  test('un numéro valide rend le texte exact de la page', () => {
    const cible = blocs.find((b) => /réseau de distributeurs/.test(b.text))!;
    const out = resolveSelection(
      {
        evidenceBlockId: cible.id,
        normalizedClaim: 'L’entreprise développe son réseau de distributeurs',
        evidenceType: 'COMMERCIAL_FACT',
      },
      blocs, source,
    );
    assert.ok(out.evidence);
    assert.equal(out.evidence!.evidenceQuote, cible.text);
    assert.equal(out.evidence!.sourceUrl, 'https://harmony-beton.com/');
    assert.equal(out.evidence!.sourcePageTitle, 'Harmony Béton — Fabricant');
  });

  test('un numéro inexistant est refusé, aucune citation n’est fabriquée', () => {
    const out = resolveSelection(
      { evidenceBlockId: 999, normalizedClaim: 'peu importe', evidenceType: 'COMMERCIAL_FACT' },
      blocs, source,
    );
    assert.equal(out.evidence, null);
    assert.match(out.reason, /inexistant/);
  });

  test('un numéro négatif ou nul est refusé', () => {
    for (const id of [0, -1, 1.5]) {
      assert.equal(
        resolveSelection(
          { evidenceBlockId: id, normalizedClaim: 'x', evidenceType: 'COMMERCIAL_FACT' },
          blocs, source,
        ).evidence,
        null,
        `id ${id}`,
      );
    }
  });

  test('le modèle ne peut pas substituer une citation inventée', () => {
    /*
     * Le cœur du dispositif. Même si le modèle « voulait » citer une phrase de
     * son cru, il n'a aucun champ pour l'écrire : il rend un numéro, et le
     * texte vient de la page.
     */
    const cible = blocs[0]!;
    const out = resolveSelection(
      {
        evidenceBlockId: cible.id,
        normalizedClaim: 'Leader mondial incontesté du béton haute performance',
        evidenceType: 'COMMERCIAL_FACT',
      },
      blocs, source,
    );
    assert.equal(out.evidence!.evidenceQuote, cible.text);
    assert.notEqual(out.evidence!.evidenceQuote, out.evidence!.normalizedClaim);
    assert.doesNotMatch(out.evidence!.evidenceQuote, /Leader mondial/);
  });

  test('une interprétation vide ne fait pas un fait', () => {
    const out = resolveSelection(
      { evidenceBlockId: blocs[0]!.id, normalizedClaim: '   ', evidenceType: 'COMMERCIAL_FACT' },
      blocs, source,
    );
    assert.equal(out.evidence, null);
  });
});

// ─── LA VÉRIFICATION ────────────────────────────────────────────────────────

describe('une citation se retrouve dans sa source, ou elle n’est pas une citation', () => {
  test('un passage tiré d’un bloc se retrouve', () => {
    const blocs = splitIntoBlocks(PAGE);
    const texte = cleanedText(PAGE);
    for (const b of blocs) {
      assert.equal(quoteExistsInSource(b.text, texte), true, b.text.slice(0, 40));
    }
  });

  test('un texte absent de la page échoue, quelle qu’en soit la provenance', () => {
    // Aucune dérogation : ce n'est pas la provenance déclarée qui vaut preuve,
    // c'est la présence dans le texte.
    const texte = cleanedText(PAGE);
    assert.equal(
      quoteExistsInSource('Leader mondial incontesté du béton haute performance', texte),
      false,
    );
  });

  test('les entités décodées ne cassent pas la comparaison', () => {
    const texte = cleanedText(PAGE);
    assert.equal(quoteExistsInSource('Notre réseau de distributeurs couvre', texte), true);
  });

  test('la paraphrase réelle qui bloquait reste rejetée par le seuil de 80 %', () => {
    /*
     * Relevé mot pour mot sur asytec.fr : le modèle avait écrit « Asytec propose
     * du sous-traitance industrielle low-cost », retrouvée à 50 %. Le seuil ne
     * bouge pas — c'est la source du fait qui change.
     */
    const v = verifyClaimAgainstSource(
      'Asytec propose du sous-traitance industrielle low-cost avec accompagnement',
      cleanedText(PAGE),
    );
    assert.equal(v.verifiable, false);
  });
});

// ─── LE COMPTE DES FAITS ────────────────────────────────────────────────────

describe('deux faits commerciaux, et deux vrais', () => {
  const preuve = (o: Partial<SourcedEvidence>): SourcedEvidence => ({
    normalizedClaim: 'Une interprétation',
    evidenceQuote: 'Nous concevons et fabriquons des solutions béton depuis 1998.',
    sourceUrl: 'https://harmony-beton.com/',
    sourcePageTitle: 'Harmony Béton',
    evidenceType: 'COMMERCIAL_FACT',
    blockId: 1,
    ...o,
  });

  test('deux faits commerciaux distincts suffisent', () => {
    const faits = [
      preuve({ blockId: 1, evidenceQuote: 'Nous fabriquons des solutions béton depuis 1998.', normalizedClaim: 'Fabricant depuis 1998' }),
      preuve({ blockId: 2, evidenceQuote: 'Notre réseau de distributeurs couvre douze départements.', normalizedClaim: 'Développe un réseau de distributeurs' }),
    ];
    assert.equal(distinctCommercialFacts(faits).length, 2);
    assert.equal(hasEnoughCommercialFacts(faits), true);
  });

  test('une identité ne compte jamais comme fait commercial', () => {
    /*
     * Le bug réel trouvé sur igus.fr : `identite:entite_juridique` = « IGUS SAS »
     * était le seul élément vérifié à 100 %, et le message aurait annoncé
     * « j'ai relevé ceci, publié sur votre site : IGUS SAS ».
     */
    const faits = [
      preuve({ evidenceType: 'IDENTITY', evidenceQuote: 'IGUS SAS, société par actions simplifiée.', blockId: 1 }),
      preuve({ evidenceType: 'IDENTITY', evidenceQuote: 'RCS Paris 123456789 au capital de 40 000 euros.', blockId: 2 }),
    ];
    assert.equal(distinctCommercialFacts(faits).length, 0);
    assert.equal(hasEnoughCommercialFacts(faits), false);
  });

  test('un contact ne compte pas davantage', () => {
    const faits = [
      preuve({ evidenceType: 'CONTACT', blockId: 1 }),
      preuve({ evidenceType: 'COMMERCIAL_FACT', blockId: 2, evidenceQuote: 'Notre réseau de distributeurs couvre douze départements.' }),
    ];
    assert.equal(distinctCommercialFacts(faits).length, 1);
    assert.equal(hasEnoughCommercialFacts(faits), false);
  });

  test('deux fois le même bloc ne fait pas deux faits', () => {
    const faits = [preuve({ blockId: 3 }), preuve({ blockId: 3 })];
    assert.equal(distinctCommercialFacts(faits).length, 1);
  });

  test('deux phrases quasi identiques ne font pas deux faits', () => {
    /*
     * Beaucoup de sites répètent leur accroche en haut de page et en pied.
     * Les compter séparément viderait de son sens l'exigence de deux faits.
     */
    const faits = [
      preuve({ blockId: 1, evidenceQuote: 'Nous concevons et fabriquons des solutions béton depuis 1998.' }),
      preuve({ blockId: 7, evidenceQuote: 'Nous concevons et fabriquons des solutions béton depuis 1998 en France.' }),
    ];
    assert.equal(distinctCommercialFacts(faits).length, 1);
    assert.equal(hasEnoughCommercialFacts(faits), false);
  });

  test('deux faits vraiment différents du même site restent deux', () => {
    const faits = [
      preuve({ blockId: 1, evidenceQuote: 'Nous concevons et fabriquons des solutions béton depuis 1998.', normalizedClaim: 'Fabricant béton' }),
      preuve({ blockId: 2, evidenceQuote: 'Nos produits sont livrés sous quarante-huit heures partout en France.', normalizedClaim: 'Livraison sous 48 h' }),
    ];
    assert.equal(distinctCommercialFacts(faits).length, 2);
  });

  test('areNearDuplicates ne confond pas deux sujets distincts', () => {
    assert.equal(
      areNearDuplicates(
        'Nous fabriquons des solutions béton depuis 1998.',
        'Nos produits sont livrés sous quarante-huit heures partout en France.',
      ),
      false,
    );
  });
});

// ─── LA CONVENTION `identite:` ──────────────────────────────────────────────

describe('le préfixe identite: écarte une preuve de toute citation commerciale', () => {
  /**
   * Les preuves d'identité sont stockées sous un champ préfixé `identite:`.
   * Trois chemins l'excluaient déjà — l'audit, la vue d'approbation, le
   * contrôle d'éligibilité — et un seul ne le faisait pas : la boucle qui écrit
   * le message. Sur igus.fr, le seul élément vérifié à 100 % était
   * `identite:entite_juridique` = « IGUS SAS », et le courriel aurait annoncé
   * « j'ai relevé ceci, publié sur votre site : IGUS SAS ».
   */
  const commercial = (field: string) => !field.startsWith('identite:');

  test('les champs d’identité connus sont écartés', () => {
    for (const f of ['identite:entite_juridique', 'identite:immatriculation', 'identite:forme']) {
      assert.equal(commercial(f), false, f);
    }
  });

  test('les champs commerciaux passent', () => {
    for (const f of ['signal:export', 'stratégie_commerciale', 'position_marche', 'verbatim:12']) {
      assert.equal(commercial(f), true, f);
    }
  });

  test('le préfixe est vérifié au début, pas n’importe où', () => {
    // « pre-identite: » ou « signal:identite » restent commerciaux : seul le
    // préfixe exact désigne une preuve d'identité.
    assert.equal(commercial('signal:identite_visuelle'), true);
  });
});

// ─── LE CATALOGUE PARTAGÉ ───────────────────────────────────────────────────

describe('le lot et la reprise posent la même question', () => {
  /**
   * Deux chemins produisent des preuves. Le jour où l'un des deux devient un
   * peu plus permissif, c'est celui qui écrit les messages. Le catalogue, le
   * schéma et la résolution vivent donc à un seul endroit.
   */
  const pages = [
    { url: 'https://harmony-beton.com/?utm_source=newsletter', html: PAGE },
    { url: 'https://harmony-beton.com/devenir-distributeur', html: '<p>Nous vous proposons soit une distribution exclusive de nos produits soit de créer votre gamme.</p>' },
  ];

  test('les numéros sont globaux et couvrent toutes les pages', () => {
    const cat = buildBlockCatalogue(pages);
    assert.ok(cat.size >= 4, `${cat.size} passage(s)`);
    assert.deepEqual([...cat.index.keys()], Array.from({ length: cat.size }, (_, i) => i + 1));
  });

  test('l’URL est canonicalisée : le suivi marketing ne survit pas', () => {
    /*
     * Une citation source collée dans un courriel avec son `utm_source` se
     * périme et signale le pistage. La canonicalisation existante s'applique
     * au catalogue comme ailleurs.
     */
    const cat = buildBlockCatalogue(pages);
    const urls = [...cat.blocksByUrl.keys()];
    assert.equal(urls.some((u) => u.includes('utm_source')), false);
    assert.ok(urls.some((u) => u === 'https://harmony-beton.com/'));
  });

  test('un numéro valide donne la citation exacte de la bonne page', () => {
    const cat = buildBlockCatalogue(pages);
    const cible = [...cat.index.entries()].find(([, v]) => v.url.includes('devenir-distributeur'))!;
    const { evidence, rejected } = resolveSelections(
      [{ evidenceBlockId: cible[0], normalizedClaim: 'Propose une distribution exclusive', evidenceType: 'COMMERCIAL_FACT' }],
      cat,
    );
    assert.equal(rejected.length, 0);
    assert.match(evidence[0]!.evidenceQuote, /distribution exclusive/);
    assert.equal(evidence[0]!.sourceUrl, 'https://harmony-beton.com/devenir-distributeur');
  });

  test('un numéro hors catalogue est refusé et rien n’est produit', () => {
    const cat = buildBlockCatalogue(pages);
    const { evidence, rejected } = resolveSelections(
      [{ evidenceBlockId: cat.size + 50, normalizedClaim: 'x', evidenceType: 'COMMERCIAL_FACT' }],
      cat,
    );
    assert.equal(evidence.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!, /inexistant/);
  });
});
