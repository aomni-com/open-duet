declare module 'next/dist/compiled/babel/parser.js' {
  export function parse(source: string, options: Record<string, unknown>): unknown

  const parser: { parse: typeof parse }
  export default parser
}
