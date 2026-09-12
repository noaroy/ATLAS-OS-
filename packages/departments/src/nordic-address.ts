/**
 * L'adresse postale suédoise, reconnue à sa forme.
 *
 * Sur le premier lot suédois réel, treize sociétés sur dix-huit sont sorties
 * « pays à vérifier » : aucune ne publie « Sverige » près de son adresse,
 * parce qu'en Suède on n'écrit pas le pays sur une enveloppe suédoise. Toutes
 * publient pourtant « 142 50 Skogås », « 247 32 Södra Sandby », « 602 23
 * Norrköping » — le code postal en trois-et-deux chiffres, puis la localité.
 *
 * Cette forme n'est pas une preuve à elle seule : la Tchéquie et la Grèce
 * l'utilisent aussi. Ce qui la rend probante, c'est la localité : « 110 00
 * Praha » n'est pas suédois, « 142 50 Skogås » l'est. La liste des localités
 * est donc la clé, et elle est close : une ville absente rend « rien », ce
 * qui est sûr, plutôt qu'un pays deviné.
 *
 * Un « SE- » devant le code, ou « Sverige » / « Sweden » juste après la
 * localité, suffit aussi, quelle que soit la localité.
 */

const LOCALITES_SUEDOISES = [
  // Les grandes villes et leurs communes.
  'Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Västerås', 'Örebro', 'Linköping', 'Helsingborg', 'Jönköping',
  'Norrköping', 'Lund', 'Umeå', 'Gävle', 'Borås', 'Södertälje', 'Eskilstuna', 'Halmstad', 'Växjö', 'Karlstad',
  'Sundsvall', 'Trollhättan', 'Östersund', 'Luleå', 'Borlänge', 'Kalmar', 'Kristianstad', 'Skövde', 'Falun',
  'Skellefteå', 'Karlskrona', 'Uddevalla', 'Landskrona', 'Nyköping', 'Motala', 'Varberg', 'Trelleborg',
  'Ängelholm', 'Lidköping', 'Piteå', 'Örnsköldsvik', 'Sandviken', 'Visby', 'Kungsbacka', 'Alingsås', 'Enköping',
  'Ystad', 'Mölndal', 'Partille', 'Täby', 'Solna', 'Sundbyberg', 'Sollentuna', 'Nacka', 'Huddinge', 'Haninge',
  'Järfälla', 'Sigtuna', 'Norrtälje', 'Kungälv', 'Vänersborg', 'Hässleholm', 'Karlshamn', 'Katrineholm',
  'Falkenberg', 'Mariestad', 'Ludvika', 'Avesta', 'Kiruna', 'Boden', 'Härnösand', 'Hudiksvall', 'Söderhamn',
  'Bollnäs', 'Mora', 'Arvika', 'Kristinehamn', 'Värnamo', 'Ljungby', 'Oskarshamn', 'Västervik', 'Nässjö',
  'Tranås', 'Eslöv', 'Staffanstorp', 'Lomma', 'Vellinge', 'Höganäs', 'Lerum', 'Stenungsund', 'Lysekil',
  'Strömstad', 'Åmål', 'Säffle', 'Hallsberg', 'Kumla', 'Lindesberg', 'Köping', 'Arboga', 'Sala', 'Fagersta',
  'Hallstahammar', 'Vimmerby', 'Nybro', 'Älmhult', 'Ronneby', 'Alvesta', 'Vetlanda', 'Eksjö', 'Gislaved',
  'Gnosjö', 'Vaggeryd', 'Skara', 'Falköping', 'Tidaholm', 'Ulricehamn', 'Kinna', 'Karlskoga', 'Degerfors',
  'Nora', 'Askersund', 'Laxå', 'Filipstad', 'Hagfors', 'Sunne', 'Torsby', 'Hedemora', 'Säter', 'Leksand',
  'Rättvik', 'Malung', 'Smedjebacken', 'Hofors', 'Ockelbo', 'Ljusdal', 'Ånge', 'Timrå', 'Kramfors', 'Sollefteå',
  'Vännäs', 'Lycksele', 'Kalix', 'Haparanda', 'Gällivare', 'Arvidsjaur', 'Älvsbyn', 'Åre', 'Krokom', 'Sveg',
  'Strängnäs', 'Mariefred', 'Flen', 'Gnesta', 'Trosa', 'Oxelösund', 'Vingåker', 'Söderköping', 'Finspång',
  'Åtvidaberg', 'Mjölby', 'Vadstena', 'Boxholm', 'Ödeshög', 'Kisa', 'Valdemarsvik', 'Kungsör', 'Surahammar',
  'Norberg', 'Skinnskatteberg', 'Tierp', 'Östhammar', 'Knivsta', 'Bålsta', 'Skutskär', 'Storvreta', 'Nynäshamn',
  'Tumba', 'Tullinge', 'Salem', 'Rönninge', 'Järna', 'Nykvarn', 'Norsborg', 'Skärholmen', 'Segeltorp',
  'Flemingsberg', 'Skogås', 'Trångsund', 'Gustavsberg', 'Saltsjöbaden', 'Älta', 'Tyresö', 'Vallentuna',
  'Åkersberga', 'Danderyd', 'Djursholm', 'Lidingö', 'Bromma', 'Spånga', 'Kista', 'Vällingby', 'Hässelby',
  'Jakobsberg', 'Barkarby', 'Kallhäll', 'Kungsängen', 'Ekerö', 'Vaxholm', 'Rimbo', 'Hallstavik', 'Märsta',
  'Rosersberg', 'Arlandastad', 'Upplands Väsby', 'Upplands-Bro', 'Sköndal', 'Farsta', 'Hägersten', 'Årsta',
  'Johanneshov', 'Enskede', 'Bandhagen', 'Älvsjö', 'Vårby', 'Jordbro', 'Västerhaninge', 'Handen', 'Vega',
  // Göteborg et l'ouest.
  'Askim', 'Hisings Backa', 'Hisings Kärra', 'Torslanda', 'Västra Frölunda', 'Angered', 'Landvetter',
  'Mölnlycke', 'Lindome', 'Billdal', 'Sävedalen', 'Jonsered', 'Floda', 'Nol', 'Surte', 'Bohus', 'Kode',
  'Ytterby', 'Skärhamn', 'Henån', 'Munkedal', 'Tanumshede', 'Bengtsfors', 'Mellerud', 'Vara', 'Grästorp',
  'Herrljunga', 'Vårgårda', 'Tranemo', 'Svenljunga', 'Bollebygd', 'Habo', 'Mullsjö', 'Tibro', 'Hjo',
  'Karlsborg', 'Töreboda', 'Götene', 'Viskafors', 'Fristad', 'Dalsjöfors', 'Sandared', 'Skene', 'Horred',
  'Kungshamn', 'Hunnebostrand', 'Ed', 'Färgelanda', 'Lilla Edet', 'Orust', 'Tjörn', 'Öckerö', 'Hönö',
  // Le sud.
  'Limhamn', 'Arlöv', 'Burlöv', 'Bjärred', 'Åkarp', 'Svedala', 'Skurup', 'Sjöbo', 'Tomelilla', 'Simrishamn',
  'Hörby', 'Höör', 'Kävlinge', 'Löddeköpinge', 'Ödåkra', 'Bjuv', 'Åstorp', 'Klippan', 'Perstorp', 'Örkelljunga',
  'Båstad', 'Laholm', 'Hyltebruk', 'Oskarström', 'Getinge', 'Sölvesborg', 'Olofström', 'Markaryd', 'Tingsryd',
  'Lessebo', 'Åseda', 'Emmaboda', 'Torsås', 'Mörbylånga', 'Färjestaden', 'Borgholm', 'Mönsterås', 'Högsby',
  'Hultsfred', 'Huskvarna', 'Gränna', 'Bankeryd', 'Taberg', 'Skillingaryd', 'Anderstorp', 'Hillerstorp',
  'Sävsjö', 'Aneby', 'Osby', 'Bromölla', 'Åhus', 'Tollarp', 'Vinslöv', 'Sösdala', 'Tyringe', 'Bjärnum',
  'Vittsjö', 'Dalby', 'Genarp', 'Veberöd', 'Södra Sandby', 'Furulund', 'Hjärup', 'Klågerup', 'Bara', 'Oxie',
  'Tygelsjö', 'Höllviken', 'Skanörmed Falsterbo', 'Skanör', 'Falsterbo', 'Anderslöv', 'Smygehamn', 'Rydsgård',
  // Le nord et le centre.
  'Holmsund', 'Robertsfors', 'Storuman', 'Vilhelmina', 'Åsele', 'Strömsund', 'Bräcke', 'Hammarstrand',
  'Sundsbruk', 'Matfors', 'Njurunda', 'Bergsjö', 'Delsbo', 'Edsbyn', 'Alfta', 'Järvsö', 'Arbrå', 'Kilafors',
  'Storvik', 'Valbo', 'Älvkarleby', 'Björklinge', 'Örbyhus', 'Gimo', 'Alunda', 'Öregrund', 'Östervåla',
  'Heby', 'Kolbäck', 'Ramnäs', 'Virsbo', 'Krylbo', 'Horndal', 'Långshyttan', 'Grängesberg', 'Fredriksberg',
  'Grycksbo', 'Bjursås', 'Svärdsjö', 'Djurås', 'Insjön', 'Orsa', 'Älvdalen', 'Vansbro', 'Sälen', 'Idre',
  'Munkfors', 'Forshaga', 'Kil', 'Grums', 'Årjäng', 'Storfors', 'Hällefors', 'Kopparberg', 'Fjugesta',
  'Frövi', 'Fellingsbro', 'Kumla', 'Hallsberg', 'Pålsboda', 'Laxå', 'Töreboda', 'Gullspång', 'Hova',
  'Malmköping', 'Sparreholm', 'Stigtomta', 'Vrena', 'Gnesta', 'Björnlunda', 'Vagnhärad', 'Hölö', 'Mölnbo',
  'Ljungsbro', 'Åby', 'Kolmården', 'Krokek', 'Skänninge', 'Mantorp', 'Borensberg', 'Vikingstad', 'Sturefors',
  'Rimforsa', 'Österbymo', 'Ankarsrum', 'Gamleby', 'Överum', 'Målilla', 'Virserum', 'Mariannelund',
  'Kisa', 'Horn', 'Slite', 'Hemse', 'Klintehamn', 'Roma', 'Fårösund',
];

const aplatir = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LOCALITES = new Set(LOCALITES_SUEDOISES.map(aplatir));

export interface SwedishPostalAddress {
  postcode: string;
  locality: string;
  /** Le fragment exact relevé, pour que la conclusion se relise. */
  extrait: string;
  /** Ce qui l'a rendue probante. */
  basis: 'LOCALITY' | 'SE_PREFIX' | 'COUNTRY_SUFFIX';
}

/*
 * Code postal « NNN NN », puis une localité d'un à trois mots. Le code
 * peut être précédé de « SE-» ; la localité peut être suivie de « Sverige »
 * ou « Sweden ». L'espace entre les deux groupes de chiffres est obligatoire :
 * c'est lui qui distingue la forme suédoise des codes à cinq chiffres
 * allemands ou finlandais.
 */
const MOTIF = /(?:\b(SE)[-\s]?)?\b(\d{3})[  ](\d{2})[  ]+([A-ZÅÄÖ][\p{L}]+(?:[  -][A-ZÅÄÖa-zåäö][\p{L}]+){0,2})(?:[  ,.]+(Sverige|Sweden|Schweden|Suède))?/gu;

/**
 * Les adresses postales suédoises que ce texte publie.
 *
 * Plusieurs adresses peuvent coexister — un siège et un dépôt — et ce n'est
 * pas une contradiction : elles disent le même pays.
 */
export function swedishPostalAddresses(texte: string): SwedishPostalAddress[] {
  const out: SwedishPostalAddress[] = [];
  const vus = new Set<string>();
  for (const m of texte.matchAll(MOTIF)) {
    const [tout, se, a, b, localiteBrute, suffixe] = m;
    const postcode = `${a} ${b}`;
    // Le premier mot de la localité seul, puis les deux, puis les trois :
    // « 247 32 Södra Sandby Tel » doit trouver « Södra Sandby ».
    const mots = localiteBrute!.replace(/ /g, ' ').split(/[ -]/);
    let locality: string | null = null;
    for (let n = mots.length; n >= 1; n -= 1) {
      const essai = mots.slice(0, n).join(' ');
      if (LOCALITES.has(aplatir(essai))) { locality = essai; break; }
    }
    let basis: SwedishPostalAddress['basis'] | null = null;
    if (locality) basis = 'LOCALITY';
    else if (se) { basis = 'SE_PREFIX'; locality = mots[0]!; }
    else if (suffixe) { basis = 'COUNTRY_SUFFIX'; locality = mots[0]!; }
    if (!basis || !locality) continue;
    const cle = `${postcode}|${aplatir(locality)}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push({ postcode, locality, extrait: tout.replace(/\s+/g, ' ').trim().slice(0, 80), basis });
  }
  return out;
}

/** Un simple test : ce texte porte-t-il une adresse suédoise ? */
export function hasSwedishPostalAddress(texte: string): boolean {
  return swedishPostalAddresses(texte).length > 0;
}
