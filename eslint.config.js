import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "harness/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "no-console": "off", // Worker code uses console for observability
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Browser scripts (no bundler, plain globals)
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        alert: "readonly",
        console: "readonly",
        btoa: "readonly",
        FormData: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
  },
  {
    // Node scripts
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
  },
  {
    // Python files are linted separately; .wrangler holds build artifacts
    ignores: ["**/*.py", "node_modules/", "dist/", ".wrangler/"],
  }
);
