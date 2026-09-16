import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const templatePath = path.join(root, 'wrangler.template.jsonc');
const outputPath = path.join(root, 'wrangler.generated.jsonc');
const mode = String(process.env.FDG_ORCHESTRATOR_MODE || 'shadow').trim().toLowerCase();
const continentalFingerprint = String(process.env.FDG_CONTINENTAL_GUARD_FINGERPRINT || '').trim().toLowerCase();

if (!['shadow', 'active'].includes(mode)) {
  throw new Error(`FDG_ORCHESTRATOR_MODE inválido: ${mode}`);
}
if (!/^[0-9a-f]{64}$/.test(continentalFingerprint)) {
  throw new Error('FDG_CONTINENTAL_GUARD_FINGERPRINT ausente ou inválido.');
}

const template = fs.readFileSync(templatePath, 'utf8');
const rendered = template
  .replaceAll('__ORCHESTRATOR_MODE__', mode)
  .replaceAll('__CONTINENTAL_GUARD_FINGERPRINT__', continentalFingerprint);
if (rendered.includes('__ORCHESTRATOR_MODE__') || rendered.includes('__CONTINENTAL_GUARD_FINGERPRINT__')) {
  throw new Error('Placeholder de configuração não foi substituído.');
}
fs.writeFileSync(outputPath, rendered);
console.log(`Config gerado: ${outputPath} (mode=${mode}; continental=${continentalFingerprint.slice(0, 12)})`);
