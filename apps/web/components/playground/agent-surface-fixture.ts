/* The reads an agent surface makes for itself.

   Skills and files are not on `MapData` — the ring does not draw them, so they
   are fetched only when a face is opened — which means the fixture has to supply
   them the way `useAgentReads` would. */
import type { FileItem, Skill } from '../../spa/knowledge-map/types'

export const SURFACE_SKILLS: readonly Skill[] = [
  { id: 'cohort-analysis', title: 'cohort-analysis', blurb: '' },
  { id: 'forecast-model', title: 'forecast-model', blurb: '' },
  { id: 'anomaly-sweep', title: 'anomaly-sweep', blurb: '' },
  { id: 'chart-pack', title: 'chart-pack', blurb: '' },
  { id: 'sql-review', title: 'sql-review', blurb: '' },
]

export const SURFACE_FILES: readonly FileItem[] = [
  {
    id: 'agents/analyst/reports',
    title: 'reports',
    kind: 'folder',
    when: '6 hrs ago',
    folder: true,
  },
  {
    id: 'agents/analyst/q3-revenue.csv',
    title: 'q3-revenue.csv',
    kind: 'csv',
    size: '412 kB',
    when: '20 min ago',
  },
  {
    id: 'agents/analyst/cohorts.sql',
    title: 'cohorts.sql',
    kind: 'sql',
    size: '6 kB',
    when: 'yesterday',
  },
  {
    id: 'agents/analyst/forecast-v4.xlsx',
    title: 'forecast-v4.xlsx',
    kind: 'xlsx',
    size: '88 kB',
    when: '3 days ago',
  },
  {
    id: 'agents/analyst/warehouse-costs.md',
    title: 'warehouse-costs.md',
    kind: 'md',
    size: '9 kB',
    when: '2 weeks ago',
  },
]
