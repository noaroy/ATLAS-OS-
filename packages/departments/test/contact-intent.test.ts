import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContactIntent,
  outreachSuitability,
  selectOutreachContact,
  type RankableContact,
} from '../src/contact-intent.ts';
import { resolveContacts } from '../src/contact-resolver.ts';

/**
 * Le lot 005 a retenu `support@groupe-reval.com` pour France Reval et
 * `sg@mecapole.fr` pour Mecapole. Les deux adresses sont réellement publiées
 * sur les sites officiels — la résolution avait donc raison, et le résultat
 * était mauvais quand même.
 *
 * « Publiée » et « destinée à recevoir une offre commerciale » sont deux
 * questions distinctes. La seconde n'était pas posée.
 */

const email = (value: string, role?: string | null) =>
  classifyContactIntent({ value, kind: 'EMAIL', role: role ?? null });

describe('à quoi sert une boîte', () => {
  test('les deux mauvais choix du lot 005 sont maintenant nommés', () => {
    assert.equal(email('support@groupe-reval.com'), 'TECHNICAL_SUPPORT');
    assert.equal(outreachSuitability('TECHNICAL_SUPPORT'), 'BLOCKED');

    assert.equal(email('sg@mecapole.fr'), 'PERSONAL', 'des initiales, pas une fonction');
    assert.equal(outreachSuitability('PERSONAL'), 'LOW');
  });

  test('les boîtes commerciales', () => {
    for (const mailbox of ['commercial', 'sales', 'ventes', 'devis', 'partenariats']) {
      assert.equal(email(`${mailbox}@x.fr`), 'SALES', mailbox);
    }
    assert.equal(outreachSuitability('SALES'), 'HIGH');
  });

  test('les boîtes export', () => {
    for (const mailbox of ['export', 'international']) {
      assert.equal(email(`${mailbox}@x.fr`), 'EXPORT', mailbox);
    }
    assert.equal(outreachSuitability('EXPORT'), 'HIGH');
  });

  test('les boîtes d’accueil', () => {
    for (const mailbox of ['contact', 'info', 'accueil', 'secretariat', 'administration']) {
      assert.equal(email(`${mailbox}@x.fr`), 'GENERAL', mailbox);
    }
    assert.equal(outreachSuitability('GENERAL'), 'MEDIUM');
  });

  test('celles auxquelles on n’écrit jamais automatiquement', () => {
    const blocked: Array<[string, string]> = [
      ['sav@x.fr', 'TECHNICAL_SUPPORT'],
      ['assistance@x.fr', 'TECHNICAL_SUPPORT'],
      ['hotline@x.fr', 'TECHNICAL_SUPPORT'],
      ['legal@x.fr', 'LEGAL'],
      ['juridique@x.fr', 'LEGAL'],
      ['dpo@x.fr', 'PRIVACY'],
      ['rgpd@x.fr', 'PRIVACY'],
      ['webmaster@x.fr', 'WEBMASTER'],
      ['admin@x.fr', 'WEBMASTER'],
      ['noreply@x.fr', 'WEBMASTER'],
    ];
    for (const [address, expected] of blocked) {
      assert.equal(email(address), expected, address);
      assert.equal(outreachSuitability(email(address)), 'BLOCKED', address);
    }
  });

  test('une personne dont la fonction commerciale est publiée redevient un interlocuteur', () => {
    // C'est l'entreprise elle-même qui la désigne : l'adresse seule ne le
    // disait pas, la fonction publiée le dit.
    assert.equal(email('e.dubroca@x.fr'), 'PERSONAL');
    assert.equal(email('e.dubroca@x.fr', 'Directeur commercial'), 'SALES');
    assert.equal(email('e.dubroca@x.fr', 'Responsable export'), 'SALES');
    assert.equal(email('e.dubroca@x.fr', 'Directeur technique'), 'PERSONAL');
  });

  test('une adresse inconnue n’est ni bloquée ni recommandée', () => {
    assert.equal(email('xyzzy@x.fr'), 'UNKNOWN');
    assert.equal(outreachSuitability('UNKNOWN'), 'LOW');
  });
});

describe('la priorité de sélection', () => {
  const contact = (
    type: RankableContact['type'],
    value: string,
    intent: RankableContact['intent'],
  ): RankableContact => ({
    type,
    value,
    sourceUrl: 'https://x.fr/contact',
    intent,
    suitability: outreachSuitability(intent),
  });

  test('le commercial passe avant tout', () => {
    const outcome = selectOutreachContact([
      contact('EMAIL', 'info@x.fr', 'GENERAL'),
      contact('EMAIL', 'commercial@x.fr', 'SALES'),
      contact('EMAIL', 'export@x.fr', 'EXPORT'),
    ]);
    assert.equal(outcome.selected?.value, 'commercial@x.fr');
  });

  test('l’export passe avant l’accueil général', () => {
    const outcome = selectOutreachContact([
      contact('EMAIL', 'info@x.fr', 'GENERAL'),
      contact('EMAIL', 'export@x.fr', 'EXPORT'),
    ]);
    assert.equal(outcome.selected?.value, 'export@x.fr');
  });

  test('un formulaire passe avant un téléphone', () => {
    const outcome = selectOutreachContact([
      contact('PHONE', '03 84 22 11 00', 'GENERAL'),
      contact('FORM', 'https://x.fr/contact', 'GENERAL'),
    ]);
    assert.equal(outcome.selected?.type, 'FORM');
  });

  test('un support publié n’est jamais retenu, même seul', () => {
    const outcome = selectOutreachContact([contact('EMAIL', 'support@x.fr', 'TECHNICAL_SUPPORT')]);
    assert.equal(outcome.selected, null);
    assert.equal(outcome.setAside.length, 1);
    assert.match(outcome.setAside[0]!.reason, /jamais démarchée/);
    assert.match(outcome.reason, /aucune n’est destinée/);
  });

  test('le téléphone rattrape un lot d’adresses toutes bloquées', () => {
    const outcome = selectOutreachContact([
      contact('EMAIL', 'support@x.fr', 'TECHNICAL_SUPPORT'),
      contact('EMAIL', 'dpo@x.fr', 'PRIVACY'),
      contact('PHONE', '03 84 22 11 00', 'GENERAL'),
    ]);
    assert.equal(outcome.selected?.type, 'PHONE');
    assert.equal(outcome.setAside.length, 2, 'les deux adresses bloquées restent visibles');
  });

  test('aucune coordonnée du tout : rien, et le motif le dit', () => {
    const outcome = selectOutreachContact([]);
    assert.equal(outcome.selected, null);
    assert.match(outcome.reason, /aucune coordonnée publiée/);
  });
});

describe('bout en bout, sur des pages figées', () => {
  test('France Reval : le support est relevé mais pas retenu', () => {
    const resolution = resolveContacts({
      officialDomain: 'groupe-reval.com',
      pages: [
        {
          url: 'https://groupe-reval.com/mentions-legales/',
          html: `<p>Contact : <a href="mailto:support@groupe-reval.com">support@groupe-reval.com</a>
                 — Tél. 05 46 42 04 16</p>`,
        },
      ],
    });

    const support = resolution.publicEmails.find((c) => c.value === 'support@groupe-reval.com');
    assert.ok(support, 'l’adresse reste observée et affichée');
    assert.equal(support!.observed, true);
    assert.equal(support!.intent, 'TECHNICAL_SUPPORT');
    assert.equal(support!.suitability, 'BLOCKED');

    assert.notEqual(resolution.method, 'EMAIL', 'ce n’est pas elle qui sert au démarchage');
    assert.equal(resolution.method, 'PHONE', 'le téléphone prend la main');
  });

  test('Mecapole : l’adresse des mentions légales est écartée au profit du formulaire', () => {
    const resolution = resolveContacts({
      officialDomain: 'mecapole.fr',
      pages: [
        {
          url: 'https://mecapole.fr/mentions-legales',
          html: '<p>Responsable de publication : <a href="mailto:sg@mecapole.fr">sg@mecapole.fr</a></p>',
        },
        {
          url: 'https://mecapole.fr/',
          html: '<form><input type="email" name="from"><textarea name="m"></textarea></form>',
        },
      ],
    });

    const sg = resolution.publicEmails.find((c) => c.value === 'sg@mecapole.fr');
    assert.equal(sg?.intent, 'PERSONAL');
    assert.equal(sg?.suitability, 'LOW');
    assert.equal(resolution.method, 'FORM');
    assert.equal(resolution.primary?.value, 'https://mecapole.fr/');
  });

  test('une adresse commerciale, si elle existe, l’emporte sur tout', () => {
    const resolution = resolveContacts({
      officialDomain: 'x.fr',
      pages: [
        {
          url: 'https://x.fr/contact',
          html: `mailto:support@x.fr mailto:commercial@x.fr mailto:info@x.fr
                 <form><textarea></textarea></form>`,
        },
      ],
    });
    assert.equal(resolution.primary?.value, 'commercial@x.fr');
    assert.equal(resolution.primary?.suitability, 'HIGH');
    assert.equal(resolution.publicEmails.length, 3, 'les trois restent observées');
  });

  test('la sélection dit ce qu’elle a écarté', () => {
    const resolution = resolveContacts({
      officialDomain: 'x.fr',
      pages: [{ url: 'https://x.fr/contact', html: 'mailto:dpo@x.fr mailto:webmaster@x.fr' }],
    });
    assert.equal(resolution.method, 'NONE');
    assert.equal(resolution.selection.setAside.length, 2);
    for (const aside of resolution.selection.setAside) {
      assert.match(aside.reason, /jamais démarchée/);
    }
  });
});

describe('les deux défauts trouvés en reprenant le lot 005', () => {
  test('un nom qui contient un mot-clé reste un nom', () => {
    // « e.maillefert » contient « mail ». La première version l'a classé
    // boîte d'accueil pour cette seule raison, et l'a choisi pour Mecapole.
    assert.equal(email('e.maillefert@x.fr'), 'PERSONAL');
    assert.equal(email('c.serviceau@x.fr'), 'PERSONAL', '« service » dans un nom');
    assert.equal(email('p.legallo@x.fr'), 'PERSONAL', '« legal » dans un nom');
    // Un mot entier, lui, compte toujours.
    assert.equal(email('mail@x.fr'), 'GENERAL');
    assert.equal(email('contact.commercial@x.fr'), 'SALES');
    assert.equal(email('service@x.fr'), 'TECHNICAL_SUPPORT');
  });

  test('l’adresse d’une société sœur passe après le formulaire de l’entreprise', () => {
    // La page de contact de Mecapole publie les adresses d'autres sociétés du
    // groupe. Elles sont bien officielles ; ce ne sont pas les siennes.
    const outcome = selectOutreachContact([
      {
        type: 'EMAIL', value: 'contact@autre-societe.fr', sourceUrl: 'https://mecapole.fr/contact',
        intent: 'GENERAL', suitability: 'MEDIUM', sameBrand: false,
      },
      {
        type: 'FORM', value: 'https://mecapole.fr/', sourceUrl: 'https://mecapole.fr/',
        intent: 'GENERAL', suitability: 'MEDIUM',
      },
    ]);
    assert.equal(outcome.selected?.type, 'FORM');
    assert.equal(outcome.selected?.value, 'https://mecapole.fr/');
  });

  test('mais elle reste utilisable s’il n’y a rien d’autre', () => {
    const outcome = selectOutreachContact([
      {
        type: 'EMAIL', value: 'contact@groupe.fr', sourceUrl: 'https://filiale.fr/contact',
        intent: 'GENERAL', suitability: 'MEDIUM', sameBrand: false,
      },
    ]);
    assert.equal(outcome.selected?.value, 'contact@groupe.fr', 'acceptée, mais en dernier');
  });

  test('une adresse de la maison passe avant celle du groupe', () => {
    const outcome = selectOutreachContact([
      {
        type: 'EMAIL', value: 'contact@groupe.fr', sourceUrl: 'https://x.fr/contact',
        intent: 'GENERAL', suitability: 'MEDIUM', sameBrand: false,
      },
      {
        type: 'EMAIL', value: 'contact@x.fr', sourceUrl: 'https://x.fr/contact',
        intent: 'GENERAL', suitability: 'MEDIUM', sameBrand: true,
      },
    ]);
    assert.equal(outcome.selected?.value, 'contact@x.fr');
  });
});

describe('la boîte qui porte le nom de la maison', () => {
  test('spl@spl-france.com est l’accueil, pas des initiales', () => {
    // Trois lettres : la règle des initiales s'appliquait, et l'adresse
    // générale de SPL sortait « personnelle », donc non retenue.
    assert.equal(
      classifyContactIntent({ value: 'spl@spl-france.com', kind: 'EMAIL' }),
      'GENERAL',
    );
    assert.equal(
      classifyContactIntent({
        value: 'spl@autre-hebergeur.fr', kind: 'EMAIL', officialDomain: 'spl-group.eu',
      }),
      'GENERAL',
      'la marque du domaine officiel compte aussi',
    );
  });

  test('de vraies initiales restent personnelles', () => {
    assert.equal(classifyContactIntent({ value: 'sg@mecapole.fr', kind: 'EMAIL' }), 'PERSONAL');
    assert.equal(classifyContactIntent({ value: 'jd@usine.fr', kind: 'EMAIL' }), 'PERSONAL');
  });
});

describe('la boîte d’une unité au sein d’un groupe', () => {
  test('marque + activité est une adresse d’organisation', () => {
    // « fadilec-automation@fauche.com » restait UNKNOWN, donc jamais retenue,
    // alors que c'est la boîte de l'unité qui fait le travail.
    assert.equal(
      classifyContactIntent({
        value: 'fadilec-automation@fauche.com', kind: 'EMAIL', officialDomain: 'fadilec-groupe.fr',
      }),
      'GENERAL',
    );
  });

  test('mais la nature de la boîte l’emporte sur l’appartenance', () => {
    for (const [address, expected] of [
      ['fadilec-services@fauche.com', 'TECHNICAL_SUPPORT'],
      ['fadilec-support@fauche.com', 'TECHNICAL_SUPPORT'],
      ['fadilec-juridique@fauche.com', 'LEGAL'],
    ] as const) {
      assert.equal(
        classifyContactIntent({ value: address, kind: 'EMAIL', officialDomain: 'fadilec-groupe.fr' }),
        expected,
        address,
      );
    }
  });
});
