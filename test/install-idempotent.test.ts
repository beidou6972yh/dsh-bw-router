import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 安装脚本的升级/幂等回归（灰狼机器的真实故障形态）。
 *
 * 旧版脚本无条件 `append_entry`，所以「已装旧版 → 升到新版」会把
 * `- id: dsh-bw-router` 再追加一遍，patch 里出现两个同名 insert。
 *
 * 这里不用 mock，也不用真宿主：每次在 `mktemp -d` 里造一棵假的项目根
 * （拷贝**真实** install-dsh.sh）+ 假 `DSH_HOME/profiles/web/cordis.patch.yml`，
 * 再用桩 `npm`/`dsh` 占住 PATH，然后**真跑脚本**（`--yes` 全路径）。
 * 断言跑两次之后条目只出现 1 次、第二次不再追加。
 */

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'install-dsh.sh');

/** 已装旧版机器的典型 patch：没有本插件条目（升级前就长这样）。 */
const PATCH_FRESH = 'agent-default-model: deepseek/flash\nmodel: deepseek/flash\n';

/** 已装旧版且 patch 里已有本插件条目（升级要处理的正是这种）。 */
const PATCH_ALREADY = [
  'agent-default-model: deepseek/flash',
  '',
  '- insert:',
  '    - id: dsh-bw-router',
  '      name: dsh-bw-router/dsh',
  '',
].join('\n');

interface Tree {
  base: string;
  home: string;
  root: string;
  binDir: string;
  patch: string;
  link: string;
}

let tree: Tree | undefined;

async function md5(file: string): Promise<string> {
  return createHash('md5').update(await readFile(file, 'utf8')).digest('hex');
}

/** 条目出现次数：断言「只出现 1 次」的唯一口径。 */
function entryCount(text: string): number {
  return text.split('id: dsh-bw-router').length - 1;
}

async function makeTree(patchBody: string): Promise<Tree> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-router-install-'));
  const root = join(base, 'pkgroot');
  const binDir = join(base, 'bin');
  const home = join(base, 'home');
  const profileDir = join(home, 'profiles', 'web');
  const patch = join(profileDir, 'cordis.patch.yml');
  const link = join(profileDir, 'node_modules', 'dsh-bw-router');

  // 假项目根：脚本按自身位置推 ROOT，所以连脚本一起拷进来跑，仓库本身零改动。
  await mkdir(join(root, 'scripts'), { recursive: true });
  await cp(SCRIPT, join(root, 'scripts', 'install-dsh.sh'));
  await writeFile(join(root, 'package.json'), '{"name":"dsh-bw-router","dsh":{}}\n', 'utf8');

  // 桩 npm/dsh：占住 PATH，绝不碰真宿主、也绝不真跑 npm ci。
  await mkdir(binDir, { recursive: true });
  for (const name of ['npm', 'dsh']) {
    // `dsh` 可以用 STUB_DUMP_FAIL=1 模拟「配置合成自检失败」（升级路径的还原回归）。
    const body =
      name === 'dsh'
        ? `#!/usr/bin/env bash\nprintf 'STUB-dsh %s\\n' "$*"\n` +
          `if [ "\${STUB_DUMP_FAIL:-0}" = "1" ]; then\n` +
          `  case "$*" in *--dump-config*) exit 1;; esac\n` +
          `fi\nexit 0\n`
        : `#!/usr/bin/env bash\nprintf 'STUB-npm %s\\n' "$*"\nexit 0\n`;
    await writeFile(join(binDir, name), body, { mode: 0o755 });
  }

  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  await writeFile(patch, patchBody, 'utf8');

  return { base, home, root, binDir, patch, link };
}

/** 真跑安装脚本；默认带上 --yes + I_KNOW_IT_RESTARTS=1（全路径，含软链与 patch 写入）。 */
function runInstall(t: Tree, args: string[] = ['--yes']): string {
  return execFileSync('bash', [join(t.root, 'scripts', 'install-dsh.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: t.home,
      PROFILE: 'web',
      PATH: `${t.binDir}:${process.env.PATH ?? ''}`,
      I_KNOW_IT_RESTARTS: '1',
    },
  });
}

/**
 * 真跑安装脚本并拿退出码/输出（失败路径必须看 status，`execFileSync` 会直接抛）。
 */
function runInstallRaw(
  t: Tree,
  args: string[] = ['--yes'],
  extraEnv: Record<string, string> = {},
): { status: number | null; output: string } {
  const result = spawnSync('bash', [join(t.root, 'scripts', 'install-dsh.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: t.home,
      PROFILE: 'web',
      PATH: `${t.binDir}:${process.env.PATH ?? ''}`,
      I_KNOW_IT_RESTARTS: '1',
      ...extraEnv,
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function patchText(t: Tree): Promise<string> {
  return readFile(t.patch, 'utf8');
}

async function backupFiles(t: Tree): Promise<string[]> {
  const profileDir = join(t.home, 'profiles', 'web');
  return (await readdir(profileDir)).filter((name) => name.includes('.bak-'));
}

beforeEach(async () => {
  tree = undefined;
});

afterEach(async () => {
  if (tree) await rm(tree.base, { recursive: true, force: true });
  tree = undefined;
});

describe('install-dsh.sh 升级幂等', () => {
  it('scripts/install-dsh.sh 通过 bash -n（语法门）', () => {
    const out = execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(out).toBe('');
  });

  it('全新机器：跑两次后 id: dsh-bw-router 只有 1 条，第二次打印「跳过追加」', async () => {
    tree = await makeTree(PATCH_FRESH);

    const first = runInstall(tree);
    expect(first).toContain('STUB-npm ci'); // 桩 npm 生效，证明没碰真 npm
    expect(entryCount(await patchText(tree))).toBe(1);
    expect(await backupFiles(tree)).toHaveLength(1);

    const afterFirst = await md5(tree.patch);
    const second = runInstall(tree);

    expect(entryCount(await patchText(tree))).toBe(1); // 关键断言：没有重复条目
    expect(await md5(tree.patch)).toBe(afterFirst); // 第二次一个字节都没写
    expect(second).toContain('patch 已有 dsh-bw-router 条目，跳过追加');
    expect(second).toContain('patch 未改');
    expect(await backupFiles(tree)).toHaveLength(1); // 跳过追加就不该再产出备份
    expect(await readlink(tree.link)).toBe(tree.root);
  });

  it('已装旧版（patch 已有条目）：升级只换软链、不重写 patch', async () => {
    tree = await makeTree(PATCH_ALREADY);
    const before = await md5(tree.patch);

    const out = runInstall(tree);

    expect(entryCount(await patchText(tree))).toBe(1);
    expect(await md5(tree.patch)).toBe(before); // patch 逐字节未变
    expect(out).toContain('跳过追加');
    expect(out).toContain('只换软链');
    expect(out).toContain('仅更新软链');
    expect(await backupFiles(tree)).toHaveLength(0); // 没写 patch 就不产生备份
    expect(await readlink(tree.link)).toBe(tree.root);
  });

  it('旧软链指向别的目录：ln -sfn 覆盖并明示「旧目标 → 新目标」', async () => {
    tree = await makeTree(PATCH_ALREADY);
    const oldInstall = join(tree.base, 'old-install-v1');
    await mkdir(oldInstall, { recursive: true });
    await rm(tree.link, { force: true });
    await symlink(oldInstall, tree.link);

    const out = runInstall(tree);

    expect(out).toContain(`覆盖旧装软链：${oldInstall} → ${tree.root}`);
    expect(await readlink(tree.link)).toBe(tree.root); // 真的换成新目标了

    const again = runInstall(tree);
    expect(again).toContain('软链已就位（目标未变）'); // 再跑一次不重复刷屏、不报错
    expect(await readlink(tree.link)).toBe(tree.root);
  });

  it('dry-run 在已装机器上：文案说明判重、且不碰 patch', async () => {
    tree = await makeTree(PATCH_ALREADY);
    const before = await md5(tree.patch);

    const out = runInstall(tree, []);

    expect(out).toContain('判重: grep -qE');
    expect(out).toContain('跳过追加');
    expect(out).toContain('dry-run：未做任何改动');
    expect(await md5(tree.patch)).toBe(before);
    expect(await backupFiles(tree)).toHaveLength(0);
    expect(await readlink(tree.link).catch(() => null)).toBe(null); // dry-run 不建软链
  });
});
describe('install-dsh.sh 自检失败路径（P2-5：升级路径不许比装之前更坏）', () => {
  it('升级 + 自检失败：patch 未改、软链还原到旧目标、文案不再谎称「已还原 patch」', async () => {
    tree = await makeTree(PATCH_ALREADY);
    const before = await md5(tree.patch);
    // 升级前的旧装：软链指向旧目录。失败后必须回到这里，而不是被删掉。
    const oldInstall = join(tree.base, 'old-install-v1');
    await mkdir(oldInstall, { recursive: true });
    await rm(tree.link, { force: true });
    await symlink(oldInstall, tree.link);

    const result = runInstallRaw(tree, ['--yes'], { STUB_DUMP_FAIL: '1' });

    expect(result.status).toBe(4);
    expect(await md5(tree.patch)).toBe(before); // patch 逐字节未改
    expect(await readlink(tree.link)).toBe(oldInstall); // 软链活着，且回到旧目标
    expect(result.output).toContain('本次未写 patch');
    expect(result.output).toContain('软链已还原到安装前目标');
    expect(result.output).not.toContain('已还原 patch'); // 本路径什么都没还原，不能说还原了
    expect(await backupFiles(tree)).toHaveLength(0); // 没写 patch 就不该有备份
  });

  it('升级 + 自检失败且原先没有软链：撤掉本次新建的软链，patch 不动', async () => {
    tree = await makeTree(PATCH_ALREADY);
    const before = await md5(tree.patch);

    const result = runInstallRaw(tree, ['--yes'], { STUB_DUMP_FAIL: '1' });

    expect(result.status).toBe(4);
    expect(await md5(tree.patch)).toBe(before);
    expect(await readlink(tree.link).catch(() => null)).toBe(null);
    expect(result.output).toContain('本次未写 patch');
    expect(result.output).toContain('撤掉本次新建的软链');
  });

  it('全新安装 + 自检失败：patch 逐字节还原、撤链，文案走「已还原 patch」分支', async () => {
    tree = await makeTree(PATCH_FRESH);
    const before = await md5(tree.patch);

    const result = runInstallRaw(tree, ['--yes'], { STUB_DUMP_FAIL: '1' });

    expect(result.status).toBe(4);
    expect(await md5(tree.patch)).toBe(before);
    expect(await backupFiles(tree)).toHaveLength(1);
    expect(result.output).toContain('已还原 patch');
    expect(await readlink(tree.link).catch(() => null)).toBe(null);
  });
});
