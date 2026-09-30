import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import ts from "typescript";

export async function loadTypeScriptModule(path) {
  const source = await readFile(path, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const errors = diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(
      errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );
  }

  const sourceUrl = pathToFileURL(path).href;
  // data: modules have no filesystem base URL. Keep runtime JS imports working
  // when a small TypeScript utility shares modules with the application.
  const parsed = ts.createSourceFile(path + ".js", outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = parsed.statements
    .filter((statement) => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith("."))
    .map((statement) => statement.moduleSpecifier);
  let executable = outputText;
  for (const specifier of imports.reverse()) {
    executable = executable.slice(0, specifier.getStart(parsed))
      + JSON.stringify(new URL(specifier.text, sourceUrl).href)
      + executable.slice(specifier.end);
  }
  const withSourceUrl = executable + "\n//# sourceURL=" + sourceUrl;
  const encoded = Buffer.from(withSourceUrl).toString("base64");
  return import("data:text/javascript;base64," + encoded);
}
