import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/extension.ts"],
    format: ["cjs"],
    external: ["vscode"],
    noExternal: [/@y-claude-code\/core/],
    clean: true,
});
