import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_FILE } from "../src/domain/config.ts";

test("matches JavaScript and TypeScript sources", () => {
  const paths = [
    "src/index.ts",
    "src/app.tsx",
    "a.mjs",
    "b.cjs",
    "c.jsx",
    "d.mts",
    "e.cts",
  ];
  for (const path of paths) assert.ok(SOURCE_FILE.test(path), path);
});

test("matches manifest and CI configuration files", () => {
  const paths = [
    "package.json",
    "packages/app/package.json",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yaml",
    "config.yaml",
    "deploy/release.yml",
    "pyproject.toml",
    "Dockerfile",
    "services/api/Dockerfile",
    "Makefile",
  ];
  for (const path of paths) assert.ok(SOURCE_FILE.test(path), path);
});

test("does not match lockfiles or other generic JSON", () => {
  const paths = [
    "package-lock.json",
    "packages/app/package-lock.json",
    "yarn.lock",
    "tsconfig.json",
    "src/data.json",
    "README.md",
    "src/styles.css",
    ".github/workflows/ci.yml.bak",
  ];
  for (const path of paths) assert.ok(!SOURCE_FILE.test(path), path);
});
