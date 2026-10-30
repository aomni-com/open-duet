declare module 'next/dist/compiled/babel/parser.js' {
  type ParseOptions = {
    sourceType: 'module'
    plugins: readonly string[]
  }

  const parser: {
    parse(source: string, options: ParseOptions): unknown
  }

  export default parser
}
