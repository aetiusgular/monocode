// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnedProcess } from "../../owned-processes/model/ownedProcesses";
import type { Block } from "../../sessions/model/session";
import {
  setPreviewDepsForTest,
  startPreview,
} from "../../app-preview/model/previewStore";
import { turnWrittenPaths } from "../../file-cards/model/documentFiles";
import { evaluateVerify, PASS_NOTE, PASS_TITLE } from "./verify";
import {
  checkServedScripts,
  parseWithAcorn,
  servedScriptPaths,
  type ScriptFetch,
} from "./scriptCheck";
import {
  noteTurnEnd,
  noteTurnStart,
  resetVerifyForTest,
  setVerifyDepsForTest,
} from "./verifyStore";

// Mac test 6.8: `const = ;` appended to src/main.js in a Vite app passed the
// preview check while the page was blank.

const ROOT = "/Users/tony/vite app";

describe("parseWithAcorn", () => {
  it("finds the syntax error and its line", async () => {
    const error = await parseWithAcorn(
      "import './style.css'\ndocument.title = 'x'\nconst = ;\n",
    );
    expect(error?.line).toBe(3);
    expect(error?.message).toMatch(/Unexpected token/);
  });

  it("accepts modules, top-level await and plain scripts", async () => {
    expect(
      await parseWithAcorn(
        "import x from './x.js'\nawait x\nexport default 1\n",
      ),
    ).toBeNull();
    expect(await parseWithAcorn("module.exports = 1\n")).toBeNull();
  });
});

describe("servedScriptPaths", () => {
  it("takes scripts inside the server folder and encodes odd names", () => {
    expect(
      servedScriptPaths(
        [
          `${ROOT}/src/main.js`,
          `${ROOT}/src/main.js`,
          `${ROOT}/src/my file.mjs`,
          `${ROOT}/-lead.cjs`,
          `${ROOT}/src/App.tsx`,
          `${ROOT}/node_modules/x/index.js`,
          "/Users/tony/other/main.js",
          `${ROOT}-copy/main.js`,
        ],
        ROOT,
      ),
    ).toEqual([
      { relative: "src/main.js", urlPath: "/src/main.js" },
      { relative: "src/my file.mjs", urlPath: "/src/my%20file.mjs" },
      { relative: "-lead.cjs", urlPath: "/-lead.cjs" },
    ]);
  });
});

describe("checkServedScripts", () => {
  const served = (
    bodies: Record<string, ScriptFetch>,
    urls: string[] = [],
  ) => ({
    fetchScript: async (url: string) => {
      urls.push(url);
      return bodies[url] ?? { status: 404 };
    },
    parseScript: parseWithAcorn,
  });

  it("fails a served script that does not parse, with the file and line", async () => {
    const urls: string[] = [];
    const deps = served(
      {
        "http://localhost:5173/src/main.js": {
          status: 200,
          contentType: "text/javascript",
          body: "console.log(1)\nconst = ;\n",
        },
      },
      urls,
    );
    const check = await checkServedScripts(
      [`${ROOT}/src/main.js`],
      ROOT,
      "http://localhost:5173/some/route",
      deps,
    );
    expect(urls).toEqual(["http://localhost:5173/src/main.js"]);
    expect(check?.problems).toEqual([
      { path: "src/main.js", line: 2, message: "Unexpected token" },
    ]);
  });

  it("skips a 404, an HTML fallback and an oversized file", async () => {
    const deps = served({
      "http://localhost:5173/a.js": {
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html></html>",
      },
      "http://localhost:5173/b.js": { status: 200, tooLarge: true },
    });
    expect(
      await checkServedScripts(
        [`${ROOT}/a.js`, `${ROOT}/b.js`, `${ROOT}/c.js`],
        ROOT,
        "http://localhost:5173/",
        deps,
      ),
    ).toBeUndefined();
  });

  it("does nothing for a turn that changed no script", async () => {
    let calls = 0;
    const check = await checkServedScripts(
      [`${ROOT}/src/App.tsx`, `${ROOT}/README.md`],
      ROOT,
      "http://localhost:5173/",
      {
        fetchScript: async () => {
          calls += 1;
          return {};
        },
        parseScript: parseWithAcorn,
      },
    );
    expect(check).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("the pass wording", () => {
  it("does not read as a pass for the page", () => {
    expect(PASS_TITLE).toBe("Server check found no problems");
    expect(PASS_NOTE).toBe(
      "The page itself was not checked: errors in the browser, such as a syntax error, do not show here.",
    );
    const result = evaluateVerify({
      sessionId: "s1",
      turnKey: "u1",
      alive: true,
      newOutput: "",
      url: "http://localhost:5173/",
      http: { status: 200 },
      at: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.report).not.toMatch(/page answers/);
    expect(result.report).toContain("The page itself was not checked");
  });
});

describe("verify after a turn that broke a served script", () => {
  let processes: Map<string, OwnedProcess>;
  const user: Block = { id: "u1", role: "user", text: "append a line" };
  const edit: Block = {
    id: "t1",
    role: "tool",
    text: "Edit src/main.js",
    tool: { title: "Edit src/main.js", kind: "edit", status: "completed" },
  };

  const fetchedFor: string[] = [];
  beforeEach(async () => {
    fetchedFor.length = 0;
    localStorage.clear();
    resetVerifyForTest();
    processes = new Map();
    setPreviewDepsForTest({
      readConfig: async () => ({
        packageJson: JSON.stringify({ scripts: { dev: "vite --port 5173" } }),
        lockfiles: [],
      }),
      resolveCwd: async (root) => root,
      probe: async () => ({ status: 200 }),
      start: async (input) => {
        const process: OwnedProcess = {
          id: "p1",
          sessionId: input.sessionId,
          cwd: input.cwd,
          kind: "server",
          title: input.title,
          command: input.command,
          status: "running",
          startedAt: 0,
          output: "VITE v8 ready\n",
        };
        processes.set(process.id, process);
        return process;
      },
      stop: async () => true,
      process: (id) => processes.get(id),
      subscribe: () => () => undefined,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    setVerifyDepsForTest({
      probe: async () => ({ status: 200 }),
      // Vite 8 serves the file as written, with status 200.
      fetchScript: async (url, previewId) => {
        fetchedFor.push(previewId);
        return url === "http://localhost:5173/src/main.js"
          ? {
              status: 200,
              contentType: "text/javascript",
              body: "import './style.css'\nconst = ;\n",
            }
          : { status: 404 };
      },
      now: () => 5,
    });
    await startPreview({
      sessionId: "s1",
      project: ROOT,
      workCwd: ROOT,
      candidate: {
        key: "script:dev",
        label: "npm run dev",
        source: "package.json",
        program: "npm",
        args: ["run", "dev"],
        cwd: "",
        env: {},
        port: 5173,
        autoPort: false,
        scriptBody: "vite --port 5173",
      },
      confirmedByUser: true,
    });
  });

  afterEach(() => {
    setVerifyDepsForTest(null);
    setPreviewDepsForTest(null);
  });

  it("names the written script", () => {
    expect(turnWrittenPaths([edit], ROOT)).toEqual([`${ROOT}/src/main.js`]);
  });

  it("fails the check with the file and line", async () => {
    noteTurnStart({ id: "s1", busy: true, blocks: [user] });
    const outcome = await noteTurnEnd({ id: "s1", blocks: [user, edit] });
    expect(outcome?.result.ok).toBe(false);
    const scripts = outcome?.result.checks.find(
      (check) => check.id === "scripts",
    );
    expect(scripts?.ok).toBe(false);
    // Security fix F6: the fetch names the running preview, whose own port
    // Rust checks.
    expect(fetchedFor).toEqual(["p1"]);
    expect(scripts?.detail).toBe(
      "src/main.js line 2 does not parse in the browser: Unexpected token",
    );
    expect(outcome?.result.report).toContain("src/main.js line 2");
  });
});
