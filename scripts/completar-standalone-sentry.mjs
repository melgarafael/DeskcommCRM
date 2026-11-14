// The ESM hook uses dynamic Module.register URLs that the Next tracer misses.
// Complete the installed dependency closure and fail the build on any mismatch.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const project = process.cwd();
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--standalone")) {
  throw Error("usage: completar-standalone-sentry.mjs [--standalone directory]");
}
// Match next.config.ts: the supported Vercel adapter deliberately disables
// output:standalone. No exemption for a missing artifact in self-host builds.
if (process.env.VERCEL && !args.length) {
  console.info("Sentry standalone: Vercel adapter uses its own output; no standalone expected");
  process.exit(0);
}
const root = fs.realpathSync(args[1] ?? path.join(project, ".next/standalone"));
const req = createRequire(path.join(project, "package.json"));
const sentryReq = createRequire(req.resolve("@sentry/nextjs/package.json"));
const sourceManifest = sentryReq.resolve("@sentry/server-runtime-injection/package.json");
const sourcePackage = path.dirname(sourceManifest);
const sourceMeta = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
const name = "@sentry/server-runtime-injection";
if (sourceMeta.name !== name || !sourceMeta.version) throw Error("invalid source package");
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const inside = (p) => p === root || p.startsWith(root + path.sep);
const targets = [];
function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(p, visit);
    else if (entry.isFile()) visit(p);
  }
}
walk(root, (p) => {
  if (p.endsWith("/node_modules/@sentry/server-runtime-injection/package.json")) targets.push(p);
});
if (!targets.length) throw Error("standalone lacks Sentry runtime package manifest");
const sourceFiles = [];
walk(path.join(sourcePackage, "build/esm"), (p) => sourceFiles.push(p));
if (
  !sourceFiles.some((p) => p.endsWith("/tracing-hooks/hook.js")) ||
  !sourceFiles.some((p) => p.endsWith("/_virtual/_commonjsHelpers.js"))
) {
  throw Error("installed Sentry ESM closure is incomplete");
}
const receipt = { name, version: sourceMeta.version, packages: [] };
for (const manifest of targets.sort()) {
  if (!inside(fs.realpathSync(manifest))) throw Error("target escapes standalone");
  const meta = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (
    meta.name !== name ||
    meta.version !== sourceMeta.version ||
    hash(manifest) !== hash(sourceManifest)
  ) {
    throw Error("standalone Sentry manifest differs from installed dependency");
  }
  const destination = path.dirname(manifest);
  const files = {};
  for (const src of sourceFiles.sort()) {
    const rel = path.relative(sourcePackage, src);
    const dst = path.join(destination, rel);
    let existingParent = path.dirname(dst);
    while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
    if (!inside(fs.realpathSync(existingParent))) throw Error("asset parent escapes standalone");
    if (fs.existsSync(dst)) {
      if (
        fs.lstatSync(dst).isSymbolicLink() ||
        !fs.statSync(dst).isFile() ||
        hash(dst) !== hash(src)
      ) {
        throw Error("standalone Sentry asset mismatch; refusing overwrite");
      }
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    }
    if (hash(dst) !== hash(src)) throw Error("copied Sentry asset hash mismatch");
    files[rel] = hash(dst);
  }
  receipt.packages.push({ manifest: path.relative(root, manifest), files });
}
const receiptPath = path.join(root, ".sentry-runtime-assets.json");
const receiptText = JSON.stringify(receipt, null, 2) + "\n";
if (fs.existsSync(receiptPath)) {
  const st = fs.lstatSync(receiptPath);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    fs.readFileSync(receiptPath, "utf8") !== receiptText
  ) {
    throw Error("existing Sentry receipt differs; refusing overwrite");
  }
} else fs.writeFileSync(receiptPath, receiptText, { flag: "wx" });
console.info(
  `Sentry standalone: ${targets.length} package(s), ${sourceFiles.length} ESM files verified, version ${sourceMeta.version}`,
);
