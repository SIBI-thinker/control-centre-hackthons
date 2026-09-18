/** pdf-parse ships no types; the lib entry point is the parser by itself. */
declare module 'pdf-parse/lib/pdf-parse.js' {
  const parse: (data: Buffer | Uint8Array) => Promise<{ text: string; numpages: number; info: unknown }>;
  export default parse;
}
