import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const templatePath = path.join(root, 'wrangler.template.jsonc');
const outputPath = path.join(root, 'wrangler.generated.jsonc');
const mode = String(process.env.FDG_ORCHESTRATOR_MODE || 'shadow').trim().toLowerCase();

if (!['shadow', 'active'].includes(mode)) {
  throw new Error(`FDG_ORCHESTRATOR_MODE inválido: ${mode}`);
}

const template = fs.readFileSync(templatePath, 'utf8');
const rendered = template.replaceAll('__ORCHESTRATOR_MODE__', mode);
if (rendered.includes('__ORCHESTRATOR_MODE__')) {
  throw new Error('Placeholder ORCHESTRATOR_MODE não foi substituído.');
}
fs.writeFileSync(outputPath, rendered);
console.log(`Config gerado: ${outputPath} (mode=${mode})`);
