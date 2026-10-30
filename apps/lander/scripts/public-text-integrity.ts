const INTENTIONAL_TEXT = ['TÂCHES'] as const
const MOJIBAKE = /â|Ã|Â|[\u0080-\u009f]|�/gu

export function findMojibake(text: string): string[] {
  const checked = INTENTIONAL_TEXT.reduce((value, allowed) => value.replaceAll(allowed, ''), text)
  return [...checked.matchAll(MOJIBAKE)].map(match => match[0])
}
