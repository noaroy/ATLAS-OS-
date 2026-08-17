/** Requête ponctuelle en lecture seule. `node scripts/q.mjs "SELECT ..."` */
import Database from 'better-sqlite3';
const db = new Database('data/atlas.db', { readonly: true });
for (const row of db.prepare(process.argv[2]).all()) console.log(JSON.stringify(row));
db.close();
