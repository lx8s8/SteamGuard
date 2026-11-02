import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { analyzeSource, normalizeJsxText, placeholders, validateResources } from "../scripts/i18n.mjs";
const root = path.resolve(import.meta.dirname, "..");
const languageSource = fs.readFileSync(path.join(root, "src/i18n/languages.ts"), "utf8");
const languageModule = ts.transpileModule(languageSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { languages, matchLanguage, resolveLanguage, parsePreference } = await import(`data:text/javascript;base64,${Buffer.from(languageModule).toString("base64")}`);

test("16 bundled language tags resolve system scripts, regions and fallback", () => {
  assert.equal(languages.length, 16);
  assert.equal(new Set(languages.map(({ code }) => code)).size, 16);
  for (const [input, expected] of [["zh-Hant-CN", "zh-TW"], ["zh-Hans-HK", "zh-CN"], ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh_SG", "zh-CN"], ["pt-PT", "pt-BR"], ["en-GB", "en"], ["ja-JP", "ja"], ["ar-EG", "ar"]]) assert.equal(matchLanguage(input), expected);
  assert.equal(resolveLanguage("system", ["nl-NL", "ja-JP"]), "ja");
  assert.equal(resolveLanguage("system", ["nl-NL"]), "en");
  assert.equal(resolveLanguage("de", ["zh-CN"]), "de");
  assert.equal(parsePreference("__proto__"), "system");
  assert.equal(parsePreference("zh-CN"), "zh-CN");
  assert.equal(languages.find(({ code }) => code === "ar").direction, "rtl");
});

test("AST migration translates UI messages and explicit templates without changing selectors or user expressions", () => {
  const input = `const navigation = [{ id: "tokens", label: "令牌" }];
function Screen({ token }) { return <button data-testid="中文技术选择器" value="中文机器值" title="管理令牌" aria-label={\`管理 \${token.name}\`} onClick={() => notify(\`已复制 \${token.name}\`)}>登录 {token.name}</button>; }`;
  const result = analyzeSource(input, "src/Example.tsx", true);
  assert.match(result.output, /get label\(\).*translate\("令牌"\)/);
  assert.match(result.output, /data-testid="中文技术选择器"/);
  assert.match(result.output, /value="中文机器值"/);
  assert.match(result.output, /title=\{translate\("管理令牌"\)\}/);
  assert.match(result.output, /translate\("登录 \{\{name\}\}", \{ name: token.name \}\)/);
  assert.match(result.output, /translate\("已复制 \{\{name\}\}", \{ name: token.name \}\)/);
  assert.equal(result.keys["中文技术选择器"], undefined);
  assert.equal(result.keys["中文机器值"], undefined);
  assert.equal(analyzeSource(result.output, "src/Example.tsx", true).output, result.output);
  const parsed = ts.createSourceFile("test.tsx", result.output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.deepEqual(parsed.parseDiagnostics, []);
});

test("mixed JSX text forms a sentence with interpolation instead of translating user values", () => {
  const input = `function View() { return <p>备份包含 {preview.groupCount}{" "}个分组，已有令牌会保留。</p>; }`;
  const result = analyzeSource(input, "src/Example.tsx", true);
  assert.match(result.output, /translate\("备份包含 \{\{groupCount\}\} 个分组，已有令牌会保留。", \{ groupCount: preview.groupCount \}\)/);
  assert.equal(normalizeJsxText("\n  多行\n  文案\n"), "多行 文案");
  const values = analyzeSource('const payload = { name: "我的账号", issuer: "自定义服务", group: "工作" }; const aliases=["google gmail 谷歌"];', "src/TokenAvatar.tsx", true);
  assert.equal(values.output, 'const payload = { name: "我的账号", issuer: "自定义服务", group: "工作" }; const aliases=["google gmail 谷歌"];');
});

test("validator rejects missing locales and broken interpolation", () => {
  assert.deepEqual(placeholders("{{name}} / {{count}}"), ["count", "name"]);
  assert.deepEqual(validateResources({ "已复制 {{name}}": "已复制 {{name}}" }, { en: { "已复制 {{name}}": "Copied {{name}}" } }), []);
  assert.equal(validateResources({ "已复制 {{name}}": "已复制 {{name}}" }, { en: { "已复制 {{name}}": "Copied {{other}}" } }).length, 1);
  assert.equal(validateResources({ "取消": "取消" }, { de: {} }).length, 1);
});

test("every shipped locale has complete, non-placeholder offline translations", () => {
  const directory = path.join(root, "src/i18n/locales");
  const resources = Object.fromEntries(languages.map(({ code }) => [code, JSON.parse(fs.readFileSync(path.join(directory, `${code}.json`), "utf8"))]));
  const base = resources["zh-CN"];
  assert.ok(Object.keys(base).length > 500);
  assert.deepEqual(validateResources(base, resources), []);
  for (const { code } of languages) {
    if (["zh-CN", "zh-TW", "en"].includes(code)) continue;
    const translated = Object.keys(base).filter((key) => resources[code][key] !== resources.en[key]);
    assert.ok(translated.length / Object.keys(base).length > .9, `${code} must not be an English placeholder`);
  }
  assert.match(resources.ar["取消"], /\p{Script=Arabic}/u);
  assert.match(resources.hi["取消"], /\p{Script=Devanagari}/u);
  assert.match(resources.ja["取消"], /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
});

test("Apple permission resources match all bundled translations", () => {
  const messages = JSON.parse(fs.readFileSync(path.join(root, "src/i18n/permission-messages.json"), "utf8"));
  const apple = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
  assert.equal(Object.keys(messages).length, 3);
  for (const { code } of languages) {
    const resource = JSON.parse(fs.readFileSync(path.join(root, `src/i18n/locales/${code}.json`), "utf8"));
    const native = fs.readFileSync(path.join(root, `src-tauri/locales/${apple[code] ?? code}.lproj/InfoPlist.strings`), "utf8");
    for (const [key, source] of Object.entries(messages)) assert.ok(native.includes(`${JSON.stringify(key)} = ${JSON.stringify(resource[source])};`), `${code}: ${key}`);
  }
});
