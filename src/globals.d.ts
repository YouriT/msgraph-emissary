/**
 * Ambient declarations for Bun text-imported template files.
 *
 * At runtime `import x from "./f.tmpl" with { type: "text" }` yields the file's
 * text (and `bun build --compile` embeds it). TypeScript needs this hint to know
 * the module's default export is a string.
 */
declare module "*.tmpl" {
  const content: string;
  export default content;
}
