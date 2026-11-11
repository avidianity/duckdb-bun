// The paths of the libduckdb shared library and the duckdb-bun native shim this
// package ships. The file imports make `bun build --compile` embed both files in
// the executable.
import libraryPath from "./libduckdb.dylib" with { type: "file" };
import shimPath from "./libduckdb_bun_shim.dylib" with { type: "file" };

export { shimPath };
export default libraryPath;
