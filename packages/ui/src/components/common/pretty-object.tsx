import { CheckIcon, XIcon } from '@phosphor-icons/react'

import { cn } from '@repo/ui/lib/utils'

/**
 * Converts camelCase, PascalCase, snake_case, or kebab-case to readable text
 * e.g. "rawInput" → "Raw input", "some-value" → "Some value"
 */
const formatIdentifier = (str: string): string => {
  const result = str
    .replace(/[-_]/g, ' ') // Replace dashes and underscores with spaces
    .replace(/([A-Z])/g, ' $1') // Insert space before capitals
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim()
    .toLowerCase()
  return result.charAt(0).toUpperCase() + result.slice(1)
}

/**
 * Check if a string looks like an identifier (code-like value)
 * that should be formatted for display
 */
const isIdentifierLike = (str: string): boolean => {
  // Skip if too long (likely prose)
  if (str.length > 50) return false
  // Skip if it has multiple spaces (likely a sentence)
  if (/\s{2,}/.test(str) || (str.includes(' ') && str.split(' ').length > 4)) return false
  // It's identifier-like if it has dashes, underscores, or camelCase
  return /[-_]/.test(str) || /[a-z][A-Z]/.test(str)
}

const formatKey = (key: string): string => formatIdentifier(key)

const formatValue = (value: string): string => {
  if (isIdentifierLike(value)) {
    return formatIdentifier(value)
  }
  return value
}

const isUrl = (str: string): boolean => {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')

const tryParseJsonStringArray = (value: string): string[] | null => {
  if (!value.startsWith('[')) return null
  try {
    const parsed = JSON.parse(value)
    if (isStringArray(parsed)) return parsed
  } catch {
    // Not valid JSON
  }
  return null
}

const isBooleanValue = (value: unknown): value is boolean | 'true' | 'false' =>
  typeof value === 'boolean' || value === 'true' || value === 'false'

const BooleanBadge = ({ value }: { value: boolean | 'true' | 'false' }) => {
  const boolValue = value === true || value === 'true'
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
      {boolValue ? (
        <CheckIcon className="size-3" weight="bold" />
      ) : (
        <XIcon className="size-3" weight="bold" />
      )}
      {boolValue ? 'True' : 'False'}
    </span>
  )
}

const StringList = ({ items }: { items: string[] }) => (
  <ul className="flex flex-col gap-1">
    {items.map((item, index) => (
      <li key={index} className="flex items-center gap-2 text-xs">
        <span className="size-1 shrink-0 rounded-full bg-muted-foreground/50" />
        <span>{formatValue(item)}</span>
      </li>
    ))}
  </ul>
)

const PrettyValue = ({ value }: { value: unknown }): React.ReactNode => {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">-</span>
  }

  // Check if string is a JSON array of strings
  if (typeof value === 'string') {
    const parsedArray = tryParseJsonStringArray(value)

    if (parsedArray) {
      return <StringList items={parsedArray} />
    }

    if (isUrl(value)) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 hover:underline break-words"
        >
          {value}
        </a>
      )
    }
  }

  if (isBooleanValue(value)) {
    return <BooleanBadge value={value} />
  }

  // Check string array BEFORE generic array
  if (isStringArray(value)) {
    return <StringList items={value} />
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">Empty array</span>
    }
    return (
      <div className="space-y-1.5">
        {value.map((item, index) => (
          <div key={index} className="rounded-sm border border-border p-2">
            <PrettyValue value={item} />
          </div>
        ))}
      </div>
    )
  }

  if (typeof value === 'object') {
    return <PrettyObject data={value} />
  }

  const strValue = String(value)
  return (
    <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {typeof value === 'string' ? formatValue(strValue) : strValue}
    </span>
  )
}

export function PrettyObject({ className, data }: { className?: string; data: unknown }) {
  if (!data) return null

  // Non-objects render as a single value
  if (typeof data !== 'object') {
    return (
      <div className={cn('text-xs', className)}>
        <PrettyValue value={data} />
      </div>
    )
  }

  // Arrays render via PrettyValue
  if (Array.isArray(data)) {
    return (
      <div className={cn('text-xs', className)}>
        <PrettyValue value={data} />
      </div>
    )
  }

  // Empty objects
  if (Object.keys(data).length === 0) {
    return <span>-</span>
  }

  // Objects with key-value pairs
  return (
    <div className={cn('space-y-2', className)}>
      {Object.entries(data).map(([key, value], index) => (
        <div key={`${key}-${index}`} className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{formatKey(key)}</div>
          <div className="text-xs">
            <PrettyValue value={value} />
          </div>
        </div>
      ))}
    </div>
  )
}
