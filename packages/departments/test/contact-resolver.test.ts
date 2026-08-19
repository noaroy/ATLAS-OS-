import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  isOfficialPage,
  brandRoot,
} from '../src/contact-resolver.ts';

/**
 * Le lot 003 a conclu « aucun contact publié » pour deux entreprises qui en
 * publient. La règle fautive exigeait que l'adresse porte le domaine du site ;
 * la règle correcte porte sur la page, pas sur l'adresse.
 *
 * Tout se joue sur des pages figées. Un test qui irait chercher les vraies
 * pages prouverait qu'elles répondent aujourd'hui, pas que le module n'invente
 * rien — et c'est cela qu'il faut établir.
 */

describe('adresse d’un autre domaine que le site', () => {
  test('seraap.com publie contact@seraap.fr : accepté', () => {
    const resolution = resolveContacts({
      officialDomain: 'seraap.com',
      pages: [
        {
          url: 'https://seraap.com/contact',
          html: `<html><body><h1>Contact</h1>
            <a href="mailto:contact@seraap.fr">Nous écrire</a>
          </body></html>`,
        },
      ],
    });
    assert.equal(resolution.publicEmails.length, 1);
    assert.equal(resolution.publicEmails[0]!.value, 'contact@seraap.fr');
    assert.equal(resolution.publicEmails[0]!.sourceUrl, 'https://seraap.com/contact');
    assert.equal(resolution.publicEmails[0]!.observed, true);
    assert.equal(resolution.publicEmails[0]!.confidence, 'HIGH', 'même marque, page de contact');
    assert.equal(resolution.method, 'EMAIL');
  });

  test('cirmeca.com publie contact@cirmeca.fr : accepté', () => {
    const resolution = resolveContacts({
      officialDomain: 'cirmeca.com',
      pages: [
        {
          url: 'https://cirmeca.com/mentions-legales',
          html: `<p>Éditeur : CIRMECA — contact@cirmeca.fr — Tél. 03 84 22 11 00</p>`,
        },
      ],
    });
    assert.equal(resolution.publicEmails[0]?.value, 'contact@cirmeca.fr');
    assert.equal(resolution.publicEmails[0]?.confidence, 'HIGH');
    assert.equal(resolution.contactSources[0], 'https://cirmeca.com/mentions-legales');
  });

  test('le domaine de l’adresse n’est jamais exigé identique', () => {
    // Une PME peut communiquer sur un domaine et héberger sur un autre. Le
    // seul lien qui compte est celui de la page.
    const resolution = resolveContacts({
      officialDomain: 'exemple-industrie.com',
      pages: [{ url: 'https://exemple-industrie.com/contact', html: 'mailto:accueil@groupe-exemple.fr' }],
    });
    assert.equal(resolution.publicEmails[0]?.value, 'accueil@groupe-exemple.fr');
    assert.equal(resolution.publicEmails[0]?.confidence, 'MEDIUM', 'marque différente : accepté, moins probant');
  });
});

describe('d’où vient la coordonnée', () => {
  test('relevée dans les mentions légales', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/mentions-legales/',
          html: `<div>SAS USINE au capital de 40 000 € — <a href="mailto:info@usine.fr">info@usine.fr</a></div>`,
        },
      ],
    });
    assert.equal(resolution.publicEmails[0]?.value, 'info@usine.fr');
    assert.equal(resolution.publicEmails[0]?.sourceUrl, 'https://usine.fr/mentions-legales/');
  });

  test('relevée sur la page /contact', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [{ url: 'https://usine.fr/contact', html: '<p>info@usine.fr</p>' }],
    });
    assert.equal(resolution.publicEmails[0]?.sourceUrl, 'https://usine.fr/contact');
  });

  test('relevée dans le pied de page, qui n’est pas dépouillé', () => {
    // Le nettoyeur HTML de la découverte supprime <footer> pour alléger le
    // contexte du modèle. Ici il ne le faut pas : c'est souvent le seul
    // endroit où l'adresse figure.
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/',
          html: `<body><main>Nos machines</main>
            <footer><a href="mailto:info@usine.fr">info@usine.fr</a> · 03 20 11 22 33</footer></body>`,
        },
      ],
    });
    assert.equal(resolution.publicEmails[0]?.value, 'info@usine.fr');
    assert.equal(resolution.publicPhones.length, 1);
  });

  test('un formulaire officiel est détecté', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/contact',
          html: `<form action="/envoi" method="post">
            <input type="email" name="from"><textarea name="message"></textarea>
            <button>Envoyer</button></form>`,
        },
      ],
    });
    assert.equal(resolution.contactFormUrl?.value, 'https://usine.fr/contact');
    assert.equal(resolution.contactFormUrl?.confidence, 'HIGH');
    assert.equal(resolution.method, 'FORM', 'sans adresse, le formulaire prend la main');
  });

  test('une barre de recherche n’est pas un formulaire de contact', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [{ url: 'https://usine.fr/', html: '<form><input type="search" name="s"></form>' }],
    });
    assert.equal(resolution.contactFormUrl, null);
    assert.equal(resolution.method, 'NONE');
  });
});

describe('ce qui est refusé', () => {
  test('une adresse devinée n’existe pas', () => {
    // Le domaine est connu, la page est vide. Aucun motif `contact@` n'est
    // appliqué : le module n'en connaît aucun.
    const resolution = resolveContacts({
      officialDomain: 'seraap.com',
      pages: [{ url: 'https://seraap.com/', html: '<h1>SERAAP</h1><p>Machines spéciales.</p>' }],
    });
    assert.deepEqual(resolution.publicEmails, []);
    assert.equal(resolution.method, 'NONE');
  });

  test('aucun motif d’adresse n’est appliqué à un nom de dirigeant', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [{ url: 'https://usine.fr/equipe', html: '<p>Directeur : Jean Dupont</p>' }],
    });
    // La liste est vide : aucun motif `prenom.nom@` n'a été appliqué au nom.
    assert.deepEqual(resolution.publicEmails, []);
    assert.equal(resolution.method, 'NONE');
  });

  test('une adresse trouvée sur un annuaire tiers est rejetée', () => {
    const resolution = resolveContacts({
      officialDomain: 'seraap.com',
      pages: [
        {
          url: 'https://www.kompass.com/fr/entreprise/seraap',
          html: '<a href="mailto:contact@seraap.fr">contact@seraap.fr</a>',
        },
      ],
    });
    assert.deepEqual(resolution.publicEmails, []);
    assert.equal(resolution.method, 'NONE');
    assert.equal(resolution.skipped.length, 1);
    assert.match(resolution.skipped[0]!.reason, /hors du domaine officiel/);
  });

  test('l’adresse de l’hébergeur n’est pas celle de l’entreprise', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/mentions-legales',
          html: `<p>Hébergeur : OVH — support@ovh.net</p><p>Contact : info@usine.fr</p>`,
        },
      ],
    });
    assert.equal(resolution.publicEmails.length, 1);
    assert.equal(resolution.publicEmails[0]!.value, 'info@usine.fr');
  });

  test('aucun contact du tout donne NONE, pas une invention', () => {
    const resolution = resolveContacts({ officialDomain: 'usine.fr', pages: [] });
    assert.equal(resolution.method, 'NONE');
    assert.equal(resolution.primary, null);
    assert.deepEqual(resolution.contactSources, []);
  });
});

describe('invariants', () => {
  test('chaque contact porte sa source et le drapeau observé', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/contact',
          html: `<a href="mailto:info@usine.fr">écrire</a><a href="tel:+33320112233">appeler</a>
                 <form><textarea name="m"></textarea></form>`,
        },
      ],
    });
    const all = [
      ...resolution.publicEmails,
      ...resolution.publicPhones,
      ...(resolution.contactFormUrl ? [resolution.contactFormUrl] : []),
    ];
    assert.ok(all.length >= 3, 'trois canaux relevés');
    for (const contact of all) {
      assert.ok(contact.sourceUrl.startsWith('https://'), `${contact.value} sans source`);
      assert.equal(contact.observed, true);
      assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(contact.confidence));
    }
  });

  test('la priorité des canaux : email, formulaire, téléphone, rien', () => {
    const page = (html: string) => ({ url: 'https://usine.fr/contact', html });
    const withEmail = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [page('mailto:info@usine.fr <form><textarea></textarea></form> tel:+33320112233')],
    });
    assert.equal(withEmail.method, 'EMAIL');

    const withForm = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [page('<form><textarea></textarea></form> <a href="tel:+33320112233">tel</a>')],
    });
    assert.equal(withForm.method, 'FORM');

    const withPhone = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [page('<a href="tel:+33320112233">03 20 11 22 33</a>')],
    });
    assert.equal(withPhone.method, 'PHONE');

    assert.equal(resolveContacts({ officialDomain: 'usine.fr', pages: [page('rien')] }).method, 'NONE');
  });

  test('un nom n’est retenu que s’il est explicitement publié', () => {
    const anonymous = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [{ url: 'https://usine.fr/contact', html: '<p>Notre équipe vous répond.</p>' }],
    });
    assert.equal(anonymous.contactPersonName, null);
    assert.equal(anonymous.contactPersonRole, null);

    const named = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/contact',
          html: `<script type="application/ld+json">
            {"@type":"Person","name":"Claire Morel","jobTitle":"Directrice commerciale"}
          </script>`,
        },
      ],
    });
    assert.equal(named.contactPersonName, 'Claire Morel');
    assert.equal(named.contactPersonRole, 'Directrice commerciale');
  });
});

describe('parcours des pages', () => {
  test('les chemins habituels sont proposés', () => {
    const urls = contactPagesFor('https://seraap.com', 'seraap.com');
    assert.ok(urls.includes('https://seraap.com/contact'));
    assert.ok(urls.includes('https://seraap.com/mentions-legales'));
    assert.ok(urls.includes('https://seraap.com/impressum'));
    assert.equal(urls[0], 'https://seraap.com/');
  });

  test('un lien de contact en pied de page est suivi', () => {
    const links = contactLinksIn(
      `<footer><a href="/fr/nous-joindre">Contact</a>
       <a href="https://linkedin.com/company/x">Nous suivre</a></footer>`,
      'https://usine.fr/',
      'usine.fr',
    );
    assert.deepEqual(links, ['https://usine.fr/fr/nous-joindre']);
  });

  test('un lien sortant n’est jamais suivi', () => {
    const links = contactLinksIn(
      '<a href="https://kompass.com/contact-usine">Contact sur Kompass</a>',
      'https://usine.fr/',
      'usine.fr',
    );
    assert.deepEqual(links, []);
  });

  test('la marque d’un domaine traverse les extensions', () => {
    assert.equal(brandRoot('seraap.com'), 'seraap');
    assert.equal(brandRoot('www.seraap.fr'), 'seraap');
    assert.equal(brandRoot('shop.cirmeca.co.uk'), 'cirmeca');
    assert.equal(isOfficialPage('https://www.seraap.com/contact', 'seraap.com'), true);
    assert.equal(isOfficialPage('https://boutique.seraap.com/', 'seraap.com'), true);
    assert.equal(isOfficialPage('https://seraap.fr/', 'seraap.com'), false, 'même marque, autre site');
  });
});

describe('ce qui ressemble à un numéro sans en être un', () => {
  test('un identifiant numérique n’est pas un téléphone', () => {
    // Relevé pour de vrai sur la page d'accueil de CIRMECA : « 00000033 100 ».
    // La première version l'a pris pour un numéro parce qu'il était assez long.
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [
        {
          url: 'https://usine.fr/',
          html: '<p>Capital 00000033 100 € — SIRET 41258963700024 — 2026 2026 2026</p>',
        },
      ],
    });
    assert.deepEqual(resolution.publicPhones, []);
  });

  test('un numéro écrit comme un numéro est reconnu', () => {
    for (const written of ['03 84 22 11 00', '03.84.22.11.00', '+33 2 51 67 84 97']) {
      const resolution = resolveContacts({
        officialDomain: 'usine.fr',
        pages: [{ url: 'https://usine.fr/contact', html: `<p>Tél. ${written}</p>` }],
      });
      assert.equal(resolution.publicPhones.length, 1, `« ${written} » non reconnu`);
    }
  });

  test('un tel: reste la source la plus sûre', () => {
    const resolution = resolveContacts({
      officialDomain: 'usine.fr',
      pages: [{ url: 'https://usine.fr/contact', html: '<a href="tel:+33251678497">appeler</a>' }],
    });
    assert.equal(resolution.publicPhones[0]?.confidence, 'HIGH');
  });
});
