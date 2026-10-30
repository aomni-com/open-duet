import {
  renderModelsReference,
  type ApprovedModelCatalog,
  type SkillsBundleFile,
} from '@repo/contract'

import { generatedSkills } from './generated'

type RenderSkillsOptions = {
  appUrl: string
  catalog: ApprovedModelCatalog
  skills: readonly SkillsBundleFile[]
}

const unresolvedPlaceholderPattern = /\{\{[^{}\r\n]+\}\}/

export function renderSkills({ appUrl, catalog, skills }: RenderSkillsOptions): SkillsBundleFile[] {
  const files = skills.map(file => ({
    path: file.path,
    content: file.content.replaceAll('{{APP_URL}}', () => appUrl),
  }))
  files.push({
    path: 'media-creation/reference/models.json',
    content: renderModelsReference(catalog),
  })

  for (const file of files) {
    const unresolved = file.content.match(unresolvedPlaceholderPattern)?.[0]
    if (unresolved !== undefined) {
      throw new Error(`Unresolved placeholder ${unresolved} in ${file.path}`)
    }
  }

  return files
}

export function renderDefaultSkills(options: {
  appUrl: string
  catalog: ApprovedModelCatalog
}): SkillsBundleFile[] {
  return renderSkills({ ...options, skills: generatedSkills })
}
