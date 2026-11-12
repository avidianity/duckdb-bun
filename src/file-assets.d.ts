// Files imported with `with { type: "file" }` resolve to their path at run time
// (and to their /$bunfs/ path inside a `bun build --compile` executable).
declare module "*.so" {
  const path: string;
  export default path;
}
declare module "*.dylib" {
  const path: string;
  export default path;
}
