import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dbId = String(process.env.FDG_D1_DATABASE_ID || '').trim();
if (!/^[0-9a-f-]{20,}$/i.test(dbId)) {
  throw new Error('FDG_D1_DATABASE_ID ausente ou inválido.');
}
const root = process.cwd();
const template = fs.readFileSync(path.join(root, 'wrangler.template.jsonc'), 'utf8');
if (!template.includes('__D1_DATABASE_ID__')) throw new Error('Placeholder D1 não encontrado.');
const rendered = template.replace('__D1_DATABASE_ID__', dbId);
fs.writeFileSync(path.join(root, 'wrangler.generated.jsonc'), rendered);
console.log('wrangler.generated.jsonc criado.');
