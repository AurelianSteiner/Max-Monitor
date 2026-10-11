import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build_without_xcode.sh');
const MISSING_PLUGIN = "error: external macro implementation type 'SwiftUIMacros.StateMacro' could not be found for macro 'State()'; plugin for module 'SwiftUIMacros' not found";

// Fake Command Line Tools: each SDK is an empty folder whose `probe` file tells the
// fake swiftc how to react; xcrun answers like the real one, including SDKROOT.
async function toolchain(t, { sdks, aliases = {}, plugin = false }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build without xcode ')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sdkDir = path.join(root, 'SDKs');
  for (const [name, probe] of Object.entries(sdks)) {
    await fs.mkdir(path.join(sdkDir, name), { recursive: true });
    if (probe !== 'ok') await fs.writeFile(path.join(sdkDir, name, 'probe'), probe);
  }
  for (const [alias, target] of Object.entries(aliases)) await fs.symlink(target, path.join(sdkDir, alias));
  const usr = path.join(root, 'toolchain', 'usr');
  const plugins = path.join(usr, 'lib', 'swift', 'host', 'plugins');
  await fs.mkdir(path.join(usr, 'bin'), { recursive: true });
  await fs.mkdir(plugins, { recursive: true });
  await fs.writeFile(path.join(plugins, 'libObservationMacros.dylib'), '');
  if (plugin) await fs.writeFile(path.join(plugins, 'libSwiftUIMacros.dylib'), '');
  const log = path.join(root, 'swiftc.log');
  await fs.writeFile(log, '');
  await fs.writeFile(path.join(usr, 'bin', 'swiftc'), `#!/bin/bash
while [[ $# -gt 0 ]]; do [[ "$1" == -sdk ]] && sdk="$2"; shift; done
printf '%s\\n' "$sdk" >> "$FAKE_SWIFTC_LOG"
case "$(cat "$sdk/probe" 2>/dev/null)" in
    macros) echo "${MISSING_PLUGIN}" >&2; exit 1 ;;
    broken) echo "error: no such module 'SwiftUI'" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  await fs.writeFile(path.join(usr, 'bin', 'xcrun'), `#!/bin/bash
case "$1" in
    --show-sdk-path) printf '%s\\n' "\${SDKROOT:-$FAKE_DEFAULT_SDK}" ;;
    --find) printf '%s\\n' "${path.join(usr, 'bin')}/$2" ;;
    *) exit 1 ;;
esac
`, { mode: 0o755 });

  return {
    sdk: name => path.join(sdkDir, name),
    async run(env = {}) {
      const { SDKROOT, ...inherited } = process.env;
      const result = spawnSync('/bin/bash', [SCRIPT, '--print-sdk'], {
        encoding: 'utf8',
        env: { ...inherited, PATH: `${path.join(usr, 'bin')}:${process.env.PATH}`,
          FAKE_DEFAULT_SDK: path.join(sdkDir, 'MacOSX.sdk'), FAKE_SWIFTC_LOG: log, ...env },
      });
      const probed = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
      return { status: result.status, output: result.stdout, selected: result.stdout.trim().split('\n').at(-1), probed };
    },
  };
}

// The layout observed after the Command Line Tools 27.0 update.
const CLT_27 = {
  sdks: { 'MacOSX27.0.sdk': 'macros', 'MacOSX26.5.sdk': 'ok', 'MacOSX26.4.sdk': 'ok', 'MacOSX15.4.sdk': 'ok' },
  aliases: { 'MacOSX.sdk': 'MacOSX27.0.sdk', 'MacOSX27.sdk': 'MacOSX27.0.sdk', 'MacOSX26.sdk': 'MacOSX26.5.sdk' },
};

test('a default SDK that compiles SwiftUI stays selected exactly as xcrun reports it', async t => {
  const tools = await toolchain(t, { sdks: { 'MacOSX26.5.sdk': 'ok' }, aliases: { 'MacOSX.sdk': 'MacOSX26.5.sdk' } });
  const result = await tools.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX.sdk'));
  assert.deepEqual(result.probed, [tools.sdk('MacOSX.sdk')]);
  assert.doesNotMatch(result.output, /Ausweich-SDK/);
});

test('a missing SwiftUIMacros plugin selects the newest installed SDK that compiles and logs it', async t => {
  const tools = await toolchain(t, CLT_27);
  const result = await tools.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX26.5.sdk'));
  // The default is probed once; the aliases of 27.0 and 26.5 are not probed again.
  assert.deepEqual(result.probed, [tools.sdk('MacOSX.sdk'), tools.sdk('MacOSX26.5.sdk')]);
  assert.match(result.output, /MacOSX27\.0\.sdk braucht für SwiftUI das Plugin SwiftUIMacros/);
  assert.match(result.output, /Ausweich-SDK gewählt: MacOSX26\.5\.sdk/);
});

test('versions are compared numerically and SDKs needing the plugin are skipped', async t => {
  const tools = await toolchain(t, {
    sdks: { 'MacOSX27.0.sdk': 'macros', 'MacOSX26.10.sdk': 'macros', 'MacOSX26.9.sdk': 'ok', 'MacOSX26.10.1.sdk': 'macros' },
    aliases: { 'MacOSX.sdk': 'MacOSX27.0.sdk' },
  });
  const result = await tools.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX26.9.sdk'));
  assert.deepEqual(result.probed.slice(1).map(sdk => path.basename(sdk)),
    ['MacOSX26.10.1.sdk', 'MacOSX26.10.sdk', 'MacOSX26.9.sdk']);
});

test('an explicit SDKROOT is used unchanged without probing', async t => {
  const tools = await toolchain(t, CLT_27);
  const result = await tools.run({ SDKROOT: tools.sdk('MacOSX27.0.sdk') });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX27.0.sdk'));
  assert.deepEqual(result.probed, []);
});

test('a toolchain with the SwiftUIMacros plugin (Xcode) keeps the default SDK without probing', async t => {
  const tools = await toolchain(t, { ...CLT_27, plugin: true });
  const result = await tools.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX.sdk'));
  assert.deepEqual(result.probed, []);
});

test('an unrelated probe failure keeps the default SDK so the real build reports the error', async t => {
  const tools = await toolchain(t, { ...CLT_27, sdks: { ...CLT_27.sdks, 'MacOSX27.0.sdk': 'broken' } });
  const result = await tools.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.selected, tools.sdk('MacOSX.sdk'));
  assert.deepEqual(result.probed, [tools.sdk('MacOSX.sdk')]);
});

test('without any buildable SDK the script stops with a German explanation', async t => {
  const tools = await toolchain(t, {
    sdks: { 'MacOSX27.0.sdk': 'macros', 'MacOSX26.5.sdk': 'macros' },
    aliases: { 'MacOSX.sdk': 'MacOSX27.0.sdk', 'MacOSX26.sdk': 'MacOSX26.5.sdk' },
  });
  const result = await tools.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /Keine installierte macOS-SDK lässt sich mit dieser Toolchain bauen \(geprüft: MacOSX27\.0\.sdk MacOSX26\.5\.sdk\)/);
  assert.match(result.output, /Plugin SwiftUIMacros, das nur Xcode mitliefert/);
  assert.match(result.output, /SDKROOT=/);
  assert.doesNotMatch(result.output, /SDK: /);
});
