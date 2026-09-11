// Loads the synthetic dataset. Every provider, site and organization here is fictional (spec §9).
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DossiersSchema, PublicRecordsSchema, type DossierEntry, type PublicRecord } from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))
export const AGENTS_DIR = resolve(here, '..')
export const REPO_DIR = resolve(here, '../..')

export function loadDossiers(): DossierEntry[] {
  return DossiersSchema.parse(JSON.parse(readFileSync(resolve(AGENTS_DIR, 'data/dossiers.json'), 'utf8')))
}
export function loadPublicRecord(): PublicRecord[] {
  return PublicRecordsSchema.parse(JSON.parse(readFileSync(resolve(AGENTS_DIR, 'data/public_record.json'), 'utf8')))
}
