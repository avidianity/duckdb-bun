// The path of the libduckdb shared library this package ships. The file import
// makes `bun build --compile` embed the library in the executable.
import libraryPath from "./libduckdb.dylib" with { type: "file" };

export default libraryPath;
