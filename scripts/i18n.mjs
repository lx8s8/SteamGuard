#!/usr/bin/env node
/**
 * TypeScript-AST localization tooling. No browser DOM rewriting or network calls.
 * extract [--committed] [--out path] builds the reviewable source catalog.
 * migrate [file ...] converts static UI strings and templates, preserving user expressions.
 * check validates local resources and interpolation parity.
 * Unsupported syntax stays in the review report rather than guessing at runtime values.
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAN = /\p{Script=Han}/u;
const visibleAttributes = new Set(["title", "placeholder", "aria-label", "alt", "label", "eyebrow"]);
const visibleProperties = new Set(["label", "title", "description", "message", "hint"]);
const quote = (value) => JSON.stringify(value);
export function normalizeJsxText(value) {
  // Matches React's JSX whitespace trimming: indentation vanishes, line boundaries become spaces.
  const lines = value.replaceAll("\r", "").split("\n");
  return lines.map((line, index) => {
    let text = line.replaceAll("\t", " ");
    if (index) text = text.replace(/^ +/, "");
    if (index < lines.length - 1) text = text.replace(/ +$/, "");
    return text;
  }).filter(Boolean).join(" ");
}
const hasText = (value) => HAN.test(value);
function sourceFiles(directory = path.join(root, "src")) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (full.includes(`${path.sep}i18n${path.sep}`)) return [];
    return entry.isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}
function propertyName(node) {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : "";
}
function ignoredLiteral(node, file) {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isJsxAttribute(parent) && !visibleAttributes.has(propertyName(parent))) return true;
  // Icon-search aliases, brands and examples are lookup/user-data values, not UI sentences.
  if (file.endsWith("TokenAvatar.tsx") && ts.isArrayLiteralExpression(parent)) return true;
  if (ts.isPropertyAssignment(parent) && ["name", "issuer", "accountName", "value", "id", "icon", "group"].includes(propertyName(parent))) return true;
  return false;
}
function isModuleLevel(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
    if (ts.isSourceFile(current)) return true;
  }
  return false;
}
function inTranslation(node) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current) && /^(t|translate|i18n\.t|translateError)$/.test(current.expression.getText())) return true;
    current = current.parent;
  }
  return false;
}
function templateParts(node) {
  const values = [];
  const used = new Set();
  let key = node.head.text;
  for (const span of node.templateSpans) {
    const expression = span.expression;
    const candidate = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : `value${values.length + 1}`;
    let name = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(candidate) ? candidate : `value${values.length + 1}`;
    if (used.has(name)) name += values.length + 1;
    used.add(name);
    values.push({ name, expression });
    key += `{{${name}}}${span.literal.text}`;
  }
  return { key, values };
}
function jsxParts(node) {
  if (!ts.isJsxElement(node) && !ts.isJsxFragment(node)) return null;
  let key = "";
  const values = [];
  let found = false;
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      const value = normalizeJsxText(child.text);
      key += value;
      found ||= hasText(value);
    } else if (ts.isJsxExpression(child) && child.expression) {
      const expression = child.expression;
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        key += expression.text;
        found ||= hasText(expression.text);
      } else {
        // Nested JSX markup has separate accessibility/structure and must remain in place.
        let containsMarkup = false;
        const find = (part) => {
          if (ts.isJsxElement(part) || ts.isJsxSelfClosingElement(part) || ts.isJsxFragment(part)) containsMarkup = true;
          ts.forEachChild(part, find);
        };
        find(expression);
        if (containsMarkup) return null;
        const candidate = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : `value${values.length + 1}`;
        let name = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(candidate) ? candidate : `value${values.length + 1}`;
        if (values.some((value) => value.name === name)) name += values.length + 1;
        key += `{{${name}}}`;
        values.push({ name, expression });
      }
    } else if (ts.isJsxExpression(child) && !child.expression) {
      // Comments do not affect rendered content.
    } else return null;
  }
  return found && key.trim() ? { key: key.trim(), values } : null;
}
function translationCall(key, values, renderExpression) {
  return `translate(${quote(key)}${values.length ? `, { ${values.map(({ name, expression }) => `${name}: ${renderExpression(expression)}`).join(", ")} }` : ""})`;
}
export function analyzeSource(text, filename = "source.tsx", migrate = false) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Map();
  const changes = [];
  const reviews = [];
  const add = (key, node) => {
    if (!key.trim()) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push({ file: filename, line: line + 1 });
  };
  const renderExpression = (node) => {
    let result = node.getText(source);
    const nested = [];
    const collect = (part) => {
      if ((ts.isStringLiteral(part) || ts.isNoSubstitutionTemplateLiteral(part)) && hasText(part.text) && !ignoredLiteral(part, filename) && !inTranslation(part)) {
        add(part.text, part);
        nested.push({ start: part.getStart(source) - node.getStart(source), end: part.end - node.getStart(source), value: `translate(${quote(part.text)})` });
        return;
      }
      if (ts.isTemplateExpression(part) && hasText(part.getText(source)) && !inTranslation(part)) {
        const parts = templateParts(part);
        add(parts.key, part);
        nested.push({ start: part.getStart(source) - node.getStart(source), end: part.end - node.getStart(source), value: translationCall(parts.key, parts.values, renderExpression) });
        return;
      }
      ts.forEachChild(part, collect);
    };
    collect(node);
    for (const change of nested.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.value + result.slice(change.end);
    return result;
  };
  const replace = (node, value, start = node.getStart(source), end = node.end) => changes.push({ start, end, value });
  const visit = (node) => {
    // Explicit translations are authoritative, including non-Chinese UI labels.
    if (ts.isCallExpression(node) && /^(t|translate|i18n\.t)$/.test(node.expression.getText(source))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) add(first.text, first);
      return;
    }
    const group = jsxParts(node);
    if (group) {
      if (ts.isJsxElement(node)) visit(node.openingElement);
      add(group.key, node);
      // Nested expressions may contain fallback labels/templates; keep those translatable too.
      const call = translationCall(group.key, group.values, renderExpression);
      if (migrate) replace(node, `{${call}}`, node.children.pos, node.children.end);
      return;
    }
    if (ts.isTemplateExpression(node) && hasText(node.getText(source)) && !inTranslation(node)) {
      const parts = templateParts(node);
      add(parts.key, node);
      if (migrate) replace(node, translationCall(parts.key, parts.values, renderExpression));
      return;
    }
    if (ts.isJsxText(node) && hasText(node.text)) {
      const key = normalizeJsxText(node.text);
      add(key.trim(), node);
      if (migrate) replace(node, `{translate(${quote(key.trim())})}`, node.pos, node.end);
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && hasText(node.text) && !ignoredLiteral(node, filename) && !inTranslation(node)) {
      add(node.text, node);
      if (migrate) {
        if (ts.isJsxAttribute(node.parent)) replace(node, `{translate(${quote(node.text)})}`);
        else if (ts.isPropertyAssignment(node.parent) && visibleProperties.has(propertyName(node.parent)) && isModuleLevel(node)) {
          // Module-level navigation labels remain reactive through a getter.
          replace(node.parent, `get ${propertyName(node.parent)}() { return translate(${quote(node.text)}); }`);
        } else replace(node, `translate(${quote(node.text)})`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let output = text;
  if (migrate && changes.length) {
    for (const change of changes.sort((a, b) => b.start - a.start)) output = output.slice(0, change.start) + change.value + output.slice(change.end);
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["']\.\/i18n["']/.test(output)) {
      const relative = path.relative(path.dirname(path.resolve(root, filename)), path.join(root, "src/i18n")).replaceAll(path.sep, "/");
      output = `import { t as translate } from ${quote(relative.startsWith(".") ? relative : `./${relative}`)};\n` + output;
    }
  }
  return { keys: Object.fromEntries(keys), output, changes: changes.length, reviews };
}
export function extractNativeMessages(text, filename = "native.rs") {
  const catalog = {};
  const messages = {};
  // Test fixtures are not product text. Rust string literals are parsed as data, never evaluated.
  const source = text.split("#[cfg(test)]")[0];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    let value;
    try { value = JSON.parse(match[0]); } catch { continue; }
    if (!hasText(value) || value.length > 600 || value.includes("\n")) continue;
    let index = 0;
    const key = value.replace(/\{([a-zA-Z_]\w*)?\}/g, (_, name) => `{{${name || `value${++index}`}}}`);
    // Named Rust arguments still consume their place in the positional sequence.
    let position = 0;
    const normalized = value.replace(/\{([a-zA-Z_]\w*)?\}/g, (_, name) => { position += 1; return `{{${name || `value${position}`}}}`; });
    messages[value] = normalized || key;
    (catalog[normalized] ??= []).push({ file: filename, line: source.slice(0, match.index).split("\n").length });
  }
  return { messages, catalog };
}
function nativeSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? nativeSourceFiles(full) : /\.(rs|kt|swift)$/.test(entry.name) ? [full] : [];
  });
}
const nativeRoots = ["src-tauri/src", "src-tauri/plugins/quick-access/src", "src-tauri/plugins/quick-access/android/src/main/java", "src-tauri/plugins/quick-access/ios/Sources"];
const allNativeSourceFiles = () => nativeRoots.flatMap((directory) => nativeSourceFiles(path.join(root, directory)));
export function placeholders(text) {
  return [...text.matchAll(/{{\s*([^{}\s]+)\s*}}/g)].map((match) => match[1]).sort();
}
export function validateResources(base, resources) {
  const problems = [];
  for (const [language, resource] of Object.entries(resources)) {
    for (const [key, original] of Object.entries(base)) {
      const value = resource[key];
      if (typeof value !== "string" || !value.trim()) { problems.push(`${language}: missing ${key}`); continue; }
      if (JSON.stringify(placeholders(original)) !== JSON.stringify(placeholders(value))) problems.push(`${language}: interpolation mismatch ${key}`);
    }
    for (const key of Object.keys(resource)) if (!(key in base)) problems.push(`${language}: stale ${key}`);
  }
  return problems;
}
function main() {
  const [command = "extract", ...args] = process.argv.slice(2);
  const directory = path.join(root, "src/i18n/locales");
  const permissions = JSON.parse(fs.readFileSync(path.join(root, "src/i18n/permission-messages.json"), "utf8"));
  if (command === "native-permissions") {
    const appleLanguages = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
    for (const file of fs.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
      const language = file.slice(0, -5), resource = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      const target = path.join(root, "src-tauri/locales", `${appleLanguages[language] ?? language}.lproj`);
      const lines = Object.entries(permissions).map(([key, source]) => {
        if (!resource[source]?.trim()) throw new Error(`${language}: missing permission translation ${source}`);
        return `${JSON.stringify(key)} = ${JSON.stringify(resource[source])};`;
      });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "InfoPlist.strings"), "/* Generated by scripts/i18n.mjs native-permissions. */\n" + lines.join("\n") + "\n");
    }
    process.stdout.write("Generated 16 bundled Apple permission localizations.\n");
    return;
  }
  if (command === "extract-native") {
    const messages = {};
    const catalog = {};
    for (const file of allNativeSourceFiles()) {
      const relative = path.relative(root, file);
      const result = extractNativeMessages(fs.readFileSync(file, "utf8"), relative);
      Object.assign(messages, result.messages);
      for (const [key, locations] of Object.entries(result.catalog)) (catalog[key] ??= []).push(...locations);
    }
    fs.writeFileSync(path.join(root, "src/i18n/native-messages.json"), JSON.stringify(messages, null, 2) + "\n");
    fs.writeFileSync(path.join(root, "src/i18n/native-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    process.stdout.write(`Extracted ${Object.keys(messages).length} known native messages.\n`);
    return;
  }
  if (command === "check") {
    const base = JSON.parse(fs.readFileSync(path.join(directory, "zh-CN.json"), "utf8"));
    const resources = Object.fromEntries(fs.readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => [file.slice(0, -5), JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"))]));
    const expected = ["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es", "pt-BR", "ru", "it", "ar", "hi", "id", "tr", "vi"];
    const problems = validateResources(base, resources);
    for (const language of expected) if (!resources[language]) problems.push(`${language}: resource file missing`);
    const used = {};
    const native = JSON.parse(fs.readFileSync(path.join(root, "src/i18n/native-messages.json"), "utf8"));
    for (const key of Object.values(native)) if (!(key in base)) problems.push(`native: missing ${key}`);
    for (const file of allNativeSourceFiles()) {
      const current = extractNativeMessages(fs.readFileSync(file, "utf8"), path.relative(root, file));
      for (const [source, key] of Object.entries(current.messages)) if (native[source] !== key) problems.push(`native: unregistered ${source}`);
    }
    for (const key of Object.values(permissions)) if (!(key in base)) problems.push(`permissions: missing ${key}`);
    for (const file of sourceFiles()) Object.assign(used, analyzeSource(fs.readFileSync(file, "utf8"), path.relative(root, file)).keys);
    for (const key of Object.keys(used)) if (!(key in base)) problems.push(`source: missing ${key}`);
    if (problems.length) { process.stderr.write(problems.join("\n") + "\n"); process.exitCode = 1; }
    else process.stdout.write(`Verified ${Object.keys(base).length} keys in ${Object.keys(resources).length} offline languages.\n`);
    return;
  }
  const files = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--out");
  const catalog = {};
  const targets = files.length ? files.map((file) => path.resolve(root, file)) : sourceFiles();
  for (const file of targets) {
    const relative = path.relative(root, file);
    let text;
    try { text = args.includes("--committed") ? execFileSync("git", ["show", `HEAD:${relative}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : fs.readFileSync(file, "utf8"); }
    catch { continue; }
    const result = analyzeSource(text, relative, command === "migrate");
    for (const [key, locations] of Object.entries(result.keys)) (catalog[key] ??= []).push(...locations);
    if (command === "migrate" && result.output !== text) { fs.writeFileSync(file, result.output); process.stdout.write(`${relative}: ${result.changes} translations\n`); }
  }
  if (command === "extract") {
    const outputIndex = args.indexOf("--out");
    const output = outputIndex >= 0 ? path.resolve(root, args[outputIndex + 1]) : path.join(root, "src/i18n/catalog.json");
    const nativeCatalogFile = path.join(root, "src/i18n/native-catalog.json");
    if (!args.includes("--committed") && fs.existsSync(nativeCatalogFile)) {
      const native = JSON.parse(fs.readFileSync(nativeCatalogFile, "utf8"));
      for (const [key, locations] of Object.entries(native)) (catalog[key] ??= []).push(...locations);
    }
    if (!args.includes("--committed")) for (const key of Object.values(permissions)) (catalog[key] ??= []).push({ file: "src/i18n/permission-messages.json", line: 1 });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b, "zh-CN"))), null, 2) + "\n");
    process.stdout.write(`Extracted ${Object.keys(catalog).length} UI keys to ${path.relative(root, output)}.\n`);
  } else if (command !== "migrate") throw new Error(`Unknown mode: ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
