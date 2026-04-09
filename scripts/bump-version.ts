#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type BumpMode = 'major' | 'minor' | 'patch' | 'set'

interface PackageJsonRecord {
  version?: unknown
  [key: string]: unknown
}

const packageJsonPath = resolve(import.meta.dir, '..', 'package.json')

function main(): void {
  const [modeArg, valueArg] = process.argv.slice(2)
  const mode = normalizeMode(modeArg)
  if (!mode) {
    throw new Error('Usage: bun scripts/bump-version.ts <major|minor|patch|set> [version]')
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJsonRecord
  const currentVersion = readVersion(packageJson)
  const nextVersion = mode === 'set'
    ? parseVersion(valueArg)
    : formatVersion(bumpVersion(parseVersion(currentVersion), mode))

  packageJson.version = nextVersion
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf-8')

  console.log(`agent-loop version updated: ${currentVersion} -> ${nextVersion}`)
}

function normalizeMode(value: string | undefined): BumpMode | null {
  switch (value) {
    case 'major':
    case 'minor':
    case 'patch':
    case 'set':
      return value
    default:
      return null
  }
}

function readVersion(packageJson: PackageJsonRecord): string {
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('package.json does not contain a valid version field')
  }

  return packageJson.version.trim()
}

function parseVersion(input: string | undefined): [number, number, number] {
  if (!input) {
    throw new Error('A version value is required')
  }

  const match = input.trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    throw new Error(`Invalid version "${input}". Expected x.y.z`)
  }

  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ]
}

function bumpVersion(
  [major, minor, patch]: [number, number, number],
  mode: Exclude<BumpMode, 'set'>,
): [number, number, number] {
  switch (mode) {
    case 'major':
      return [major + 1, 0, 0]
    case 'minor':
      return [major, minor + 1, 0]
    case 'patch':
      return [major, minor, patch + 1]
  }
}

function formatVersion([major, minor, patch]: [number, number, number]): string {
  return `${major}.${minor}.${patch}`
}

main()
