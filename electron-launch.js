// Launcher: resolves the LOCAL electron binary via require("electron") and spawns it.
// This avoids npm's global-prefix resolution that was picking up the broken global electron@43.
const { spawn } = require("child_process");
const electronPath = require("electron");
const args = process.argv.slice(2);
if (!args.includes(".") && !args.includes(process.cwd())) {
  args.unshift(".");
}
// Electron's bundled Node rejects certain NODE_OPTIONS from the parent env (e.g. --use-system-ca).
const env = Object.assign({}, process.env);
delete env.NODE_OPTIONS;
const child = spawn(electronPath, args, { stdio: "inherit", windowsHide: false, env });
child.on("exit", (code) => process.exit(code === null ? 1 : code));
