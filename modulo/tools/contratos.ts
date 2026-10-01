// Las mismas herramientas que usa la aplicación, importables sin el servidor HTTP.
// Cada export es una herramienta { description, args (zod), execute(args, ctx) } → nombre contratos_<export>.
export * from "../../src/tools/contratos.js"
